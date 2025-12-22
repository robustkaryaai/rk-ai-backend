import { databases } from "./appwriteClient.js"; // your existing client

export async function getUserTier(userId) {
  const res = await databases.getDocument(
    process.env.APPWRITE_DB_ID,
    "users",          // your users collection
    userId
  );

  // ✅ You said it's "4" → studio
  const tierMap = {
    0: "free",
    1: "student",
    2: "creator",
    3: "pro",
    4: "studio"
  };

  return tierMap[res.tier] || "free";
}
