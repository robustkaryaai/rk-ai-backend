import { supabase } from "./supabaseClient.js";

export async function getUserStorageUsage(slug) {
  const { data, error } = await supabase
    .from("files")
    .select("size_mb, type")
    .eq("slug", slug);

  if (error) throw error;

  let total = 0;
  let videos = 0;

  for (const file of data) {
    total += file.size_mb;
    if (file.type === "video") videos++;
  }

  return { totalMB: total, videoCount: videos };
}
