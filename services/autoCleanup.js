import { supabase } from "./supabaseClient.js";
import { getUserPlanBySlug } from "./appwriteClient.js";
import { getUserStorageUsage } from "./storageUsage.js";
import { PLAN_LIMITS } from "../config/plans.js";

export async function enforceStorageRules(slug) {
  const user = await getUserPlanBySlug(slug);
  const plan = PLAN_LIMITS[user.subscription_tier];

  const { totalMB, videoCount } = await getUserStorageUsage(slug);

  // ❌ VIDEO LIMIT BLOCK
  if (videoCount >= plan.video_limit && plan.video_limit !== Infinity) {
    throw new Error("VIDEO_LIMIT_REACHED");
  }

  // ✅ STORAGE CLEANUP
  if (totalMB > plan.storage_mb) {
    const overflow = totalMB - plan.storage_mb;

    const { data: files } = await supabase
      .from("files")
      .select("*")
      .eq("slug", slug)
      .order("created_at", { ascending: true });

    let deleted = 0;

    for (const file of files) {
      if (deleted >= overflow) break;

      await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .remove([file.path]);

      await supabase
        .from("files")
        .delete()
        .eq("id", file.id);

      deleted += file.size_mb;
    }
  }
}
