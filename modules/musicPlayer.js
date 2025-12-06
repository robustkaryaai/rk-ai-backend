// musicPlayer.js
import ytdl from "@distube/ytdl-core";
import ytSearch from "yt-search";
import fs from "fs";
import path from "path";

export async function handleMusic(prompt, slug) {
  let result = { link: null, file_path: null };

  // ✅ Search YouTube
  const search = await ytSearch(prompt);
  const video = search.videos[0];

  if (!video) {
    return { error: "No video found for: " + prompt };
  }

  result.link = video.url;

  // ✅ Local music folder (MCU safe)
  const slugFolder = path.join("./slug_data", `slug-${slug}`);
  fs.mkdirSync(slugFolder, { recursive: true });

  const filePath = path.join(slugFolder, `${video.videoId}.mp3`);

  // ✅ Download only if not exists
  if (!fs.existsSync(filePath)) {
    const stream = ytdl(video.url, {
      filter: "audioonly",
      quality: "highestaudio",
      highWaterMark: 1 << 25 // ✅ Prevent throttling crash
    });

    const writeStream = fs.createWriteStream(filePath);
    stream.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
  }

  result.file_path = filePath;
  return result;
}
