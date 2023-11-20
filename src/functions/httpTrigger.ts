import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlockBlobClient, ContainerClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import bs58 = require("bs58");
import JSON5 = require("json5");

function encodeKey(key: Uint8Array): string { return bs58.encode(key); }
function decodeKey(key: string): Uint8Array { return bs58.decode(key); }

function calculateDeviceID(key: string | Uint8Array): bigint {
    // if key is a string, convert it to a buffer 
    key = typeof key === 'string' ? decodeKey(key) : key;
    return fnv1(key);
}

function fnv1(input: Uint8Array): bigint {
    const fnvPrime = BigInt("1099511628211");
    const fnvOffset = BigInt("14695981039346656037");

    let hash = fnvOffset;
    for (let i = 0; i < input.length; i++) {
        hash = BigInt.asUintN(64, hash * fnvPrime)
        hash ^= BigInt(input[i])
    }
    return hash;
}

async function sha256(data: BufferSource) {
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(buffer);
}

function toHex(data: WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>): string {
    return Buffer.from(data).toString("hex");
}

function fromHex(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function encrypt(key: Uint8Array, data: BufferSource): Promise<{ salt: Uint8Array; encryptedData: Uint8Array; }> {
    const $key = await crypto.subtle.importKey("raw", key.buffer, "AES-CBC", false, ['encrypt']);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encryptedData = await crypto.subtle.encrypt({ name: "AES-CBC", iv: salt }, $key, data);
    return { salt, encryptedData: new Uint8Array(encryptedData) };
}

async function decrypt(key: Uint8Array, salt: Uint8Array, encryptedData: Uint8Array): Promise<Uint8Array> {
    const $key = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    const result = await crypto.subtle.decrypt({ name: "AES-CBC", iv: salt }, $key, encryptedData);
    return new Uint8Array(result);
}

async function upload(client: ContainerClient, deviceKey: Uint8Array, data: BufferSource, type: 'attach' | 'prov', contentType: string): Promise<string> {
    const deviceID = calculateDeviceID(deviceKey);
    const { salt, encryptedData } = await encrypt(deviceKey, data);
    const dataHash = toHex(await sha256(encryptedData));
    const blobName = `${client.containerName}/${deviceID}/${type}/${dataHash}`;
    await client.uploadBlockBlob(blobName, encryptedData.buffer, encryptedData.length, {
        metadata: {
            gdtcontenttype: contentType,
            gdthash: toHex(await sha256(data)),
            gdtsalt: toHex(salt)
        },
        blobHTTPHeaders: {
            blobContentType: "application/octet-stream"
        }
    });
    return dataHash;
}

async function decryptBlob(client: BlockBlobClient, deviceKey: Uint8Array) {
    const props = await client.getProperties();
    const salt = props.metadata?.["gdtsalt"];
    if (!salt) throw new Error(`Missing Salt ${client.name}`);
    const buffer = await client.downloadToBuffer();
    const data = await decrypt(deviceKey, fromHex(salt), buffer);
    const hash = props.metadata?.["gdthash"];
    if (hash) {
        if (!areEqual(fromHex(hash), await sha256(data))) {
            throw new Error(`Invalid Hash ${client.name}`);
        }
    }
    const contentType = props.metadata?.["gdtcontenttype"];
    return { data, contentType };

    function areEqual(first: Uint8Array, second: Uint8Array) {
        return first.length === second.length
            && first.every((value, index) => value === second[index]);
    }
}

const accountName = process.env["AZURE_STORAGE_ACCOUNT_NAME"];
const accountKey = process.env["AZURE_STORAGE_ACCOUNT_KEY"];
const baseUrl = `https://${accountName}.blob.core.windows.net`

const cred = new StorageSharedKeyCredential(accountName, accountKey);
const containerClient = new ContainerClient(`${baseUrl}/gosqas`, cred);

async function getProvenance(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`getProvenance ${request.params.deviceKey}`);

    const containerExists = await containerClient.exists();
    if (!containerExists) { return { jsonBody: [] }; }

    const deviceKey = decodeKey(request.params.deviceKey);
    const deviceID = calculateDeviceID(deviceKey);

    const records = new Array<any>();
    for await (const blob of containerClient.listBlobsFlat({ prefix: `gosqas/${deviceID}/prov/` })) {
        const blobClient = containerClient.getBlockBlobClient(blob.name);
        const { data } = await decryptBlob(blobClient, deviceKey);
        const json = new TextDecoder().decode(data);
        records.push(JSON.parse(json));
    }
    return { jsonBody: records };
}

async function getAttachement(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`getAttachement ${request.params.deviceKey}/${request.params.attachmentID}`);

    const containerExists = await containerClient.exists();
    if (!containerExists) { return { status: 404 }; }

    const deviceKey = decodeKey(request.params.deviceKey);
    const deviceID = calculateDeviceID(deviceKey);
    const attachmentID = request.params.attachmentID;

    const blobClient = containerClient.getBlockBlobClient(`gosqas/${deviceID}/attach/${attachmentID}`);
    const exists = await blobClient.exists();
    if (!exists) { return { status: 404 }; }

    const { data, contentType } = await decryptBlob(blobClient, deviceKey);
    return {
        body: data,
        headers: contentType
            ? { "Content-Type": contentType }
            : undefined
    };
};

async function postProvenance(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`postProvenance ${request.params.deviceKey}`);

    await containerClient.createIfNotExists();

    const deviceKey = decodeKey(request.params.deviceKey);

    const formData = await request.formData();
    const provenanceRecord = formData.get("provenanceRecord");
    if (typeof provenanceRecord !== 'string') { return { status: 404 }; }
    const record = JSON5.parse(provenanceRecord);

    const attachments = new Array<string>();
    {
        for (const attach of formData.getAll("attachment")) {
            if (typeof attach === 'string') continue;
            const data = await attach.arrayBuffer()
            const attachmentID = await upload(containerClient, deviceKey, data, "attach", attach.type);
            attachments.push(attachmentID);
        }
    }

    {
        const data = new TextEncoder().encode(JSON.stringify({ record, attachments }));
        const recordID = await upload(containerClient, deviceKey, data, "prov", "application/json");
        return { jsonBody: { record: recordID, attachments } };
    }
}

app.get("getProvenance", {
    authLevel: 'anonymous',
    route: 'provenance/{deviceKey}',
    handler: getProvenance,
})

app.post("postProvenance", {
    authLevel: 'anonymous',
    route: 'provenance/{deviceKey}',
    handler: postProvenance
})

app.get("getAttachement", {
    authLevel: 'anonymous',
    route: 'attachment/{deviceKey}/{attachmentID}',
    handler: getAttachement
})
