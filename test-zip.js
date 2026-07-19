import fs from "fs";
import { ZipArchive } from "archiver";

const output = fs.createWriteStream("test.zip");
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on("close", () => console.log("Zip complete!"));
archive.pipe(output);
archive.append("hello world", { name: "hello.txt" });
archive.finalize();
