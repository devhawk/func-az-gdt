import { File } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises'
import { join, extname} from 'node:path'
import { lookup as mimelookup} from 'mime-types'

const baseUrl = "https://gosqasbe.azurewebsites.net/api"

async function getProvRecords(deviceKey: string) {
    const response = await fetch(`${baseUrl}/provenance/${deviceKey}`, {
        method: "GET",
    });
    return await response.json() as { record: any, attachments?: string[] }[];
}

async function getAttachment(deviceKey: string, attachmentID: string) {
    const response = await fetch(`${baseUrl}/attachment/${deviceKey}/${attachmentID}`, {
        method: "GET",
    });
    return await response.blob();
}

async function putProvRecord(deviceKey: string, record: any, attachments: readonly Blob[]) {
    const formData = new FormData();
    formData.append("provenanceRecord", JSON.stringify(record));
    for (const blob of attachments) {
        formData.append("attachment", blob);
    }
    const response = await fetch(`${baseUrl}/provenance/${deviceKey}`, {
        method: "POST",
        body: formData,
    });
    return await response.json();
}

async function main() {
    const deviceKey = "5LAtuNjm3iuAR3ohpjTMy7";
    const record = {
        id: 95,
        title: 'Wholesale cargo lashing Belt',
        price: 930,
        quantity: 1,
        total: 930,
        discountPercentage: 17.67,
        discountedPrice: 766,
    }
    const images = new Array<File>();
    for await (const image of getImages()) {
        images.push(image);
    }

    const $json = await putProvRecord(deviceKey, record, images);
    console.log($json);
    return;

    const json = await getProvRecords(deviceKey);
    console.log(json);

    const attachment = json[0].attachments?.[0];
    if (attachment) {
        console.log(`Downloading ${attachment}`);
        await getAttachment(deviceKey, attachment!);
    }

    async function* getImages(): AsyncGenerator<File, void, unknown> {
        for (const fileName of await readdir(__dirname)) {
            const ext = extname(fileName);
            if (ext === ".ts") continue;
            const type = mimelookup(ext) || 'application/octet-stream';
            const buffer = await readFile(join(__dirname, fileName));
            yield new File([buffer], fileName, { type });
        }
    }
   
}

main().catch(e => console.error(e));

