import axios from "axios";
import fs from "fs";

const API_KEY = process.env.ASSEMBLY_AI_KEY;

export async function transcribeMP3(mp3Path) {
  let audioURL = mp3Path;

  // If it's a local file, upload it to AssemblyAI
  if (!mp3Path.startsWith("http")) {
    const fileData = fs.readFileSync(mp3Path);

    const uploadRes = await axios.post(
      "https://api.assemblyai.com/v2/upload",
      fileData,
      {
        headers: {
          authorization: API_KEY,
          "content-type": "application/octet-stream",
        },
      }
    );

    audioURL = uploadRes.data.upload_url;

    // Delete the local file immediately after upload
    fs.unlinkSync(mp3Path);
  }

  // Create transcript
  const transcriptRes = await axios.post(
    "https://api.assemblyai.com/v2/transcript",
    { audio_url: audioURL, speech_models: ["universal"] },
    { headers: { authorization: API_KEY } }
  );

  const transcriptId = transcriptRes.data.id;

  // Poll until done
  let transcript;
  while (true) {
    const statusRes = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { authorization: API_KEY } }
    );

    if (statusRes.data.status === "completed") {
      transcript = statusRes.data.text;
      break;
    } else if (statusRes.data.status === "failed") {
      throw new Error("Transcription failed");
    }

    await new Promise((res) => setTimeout(res, 1000));
  }

  return transcript;
}
