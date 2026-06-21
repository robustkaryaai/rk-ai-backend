import { Client, Databases, Query, ID, Users } from "node-appwrite";
import dotenv from "dotenv";

dotenv.config(); // ✅ THIS IS CRITICAL

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)     // ✅ MUST be full URL
  .setProject(process.env.APPWRITE_PROJECT_ID)    // ✅ Project ID
  .setKey(process.env.APPWRITE_API_KEY);          // ✅ THIS WAS MISSING

export const db = new Databases(client);
export const users = new Users(client);

export async function getUserPlanBySlug(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))] // ✅ integer slug
  );

  if (!res.documents.length) {
    throw new Error("Invalid slug");
  }

  return res.documents[0];
}

export async function checkDeviceBySlug(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))]
  );

  return res.documents.length > 0;
}

export async function ensureDeviceBySlug(slug, deviceType = "home") {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))]
  );

  if (res.documents.length > 0) {
    // If device exists but doesn't have device_type, set it
    const device = res.documents[0];
    if (!device.device_type) {
      await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        device.$id,
        { device_type: deviceType }
      );
    }
    return { created: false };
  }

  await db.createDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    ID.unique(),
    {
      slug: Number(slug),
      subscription: "false",
      "subscription-tier": 0,
      name_of_device: "RK AI",
      storage_limit_mb: 500,
      storageUsing: "supabase",
      device_type: deviceType,
      subscription_expires_at: null,
      tokensUsed: 0,
      imagesUsed: 0,
      videosUsed: 0,
      usageResetAt: null
    }
  );

  return { created: true };
}

// Get subscription status for a slug
export async function getSubscriptionStatus(slug) {
  await ensureDeviceBySlug(slug, "desktop"); // Auto-create if it doesn't exist
  const device = await getUserPlanBySlug(slug);
  const now = new Date();
  let status = "expired";

  // Check if subscription is active
  if (device.subscription === "true") {
    // If there's an expiry date, check it
    if (device.subscription_expires_at) {
      const expiryDate = new Date(device.subscription_expires_at);
      if (expiryDate > now) {
        status = "active";
      } else {
        // Expired, reset subscription
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          {
            subscription: "false",
            "subscription-tier": 0
          }
        );
        status = "expired";
      }
    } else {
      // No expiry date, assume active
      status = "active";
    }
  } else {
    status = "free";
  }

  // Calculate days left
  let daysLeft = 0;
  if (device.subscription_expires_at) {
    const expiryDate = new Date(device.subscription_expires_at);
    const diffMs = expiryDate - now;
    daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  } else if (device.subscription === "true") {
    daysLeft = 9999; // No expiry set
  }

  // Handle monthly usage resets
  if (device.usageResetAt && new Date(device.usageResetAt) <= now) {
    // Reset limits and push reset date forward 30 days
    const nextReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        tokensUsed: 0,
        imagesUsed: 0,
        videosUsed: 0,
        usageResetAt: nextReset
      }
    );
  }

  // Map tier to plan name
  const tierMap = { 0: "free", 1: "pro", 2: "elite", 3: "quantum", 4: "infinity", "infinity": "infinity" };
  const plan = tierMap[device["subscription-tier"]] || "free";

  return {
    status,
    plan,
    tier: device["subscription-tier"],
    days_left: daysLeft,
    expires_at: device.subscription_expires_at,
    device_type: device.device_type || "home",
    tokensUsed: device.tokensUsed || 0,
    imagesUsed: device.imagesUsed || 0,
    videosUsed: device.videosUsed || 0
  };
}

// Update subscription and set expiry
export async function updateSubscription(slug, plan, durationDays = 30) {
  const device = await getUserPlanBySlug(slug);
  const tierMap = { "free": 0, "pro": 1, "elite": 2, "quantum": 3, "infinity": 4 };
  const tier = tierMap[plan] || 0;
  const now = new Date();
  let expiresAt = null;
  let usageResetAt = null;

  if (plan !== "free") {
    expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    usageResetAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  await db.updateDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    device.$id,
    {
      subscription: plan !== "free" ? "true" : "false",
      "subscription-tier": tier,
      subscription_expires_at: expiresAt,
      usageResetAt: usageResetAt,
      tokensUsed: 0,
      imagesUsed: 0,
      videosUsed: 0
    }
  );

  return getSubscriptionStatus(slug);
}

export async function incrementAppwriteUsage(slug, type, amount) {
  const device = await getUserPlanBySlug(slug);
  const updates = {};
  if (type === "tokens") updates.tokensUsed = (device.tokensUsed || 0) + amount;
  if (type === "image") updates.imagesUsed = (device.imagesUsed || 0) + amount;
  if (type === "video") updates.videosUsed = (device.videosUsed || 0) + amount;

  await db.updateDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    device.$id,
    updates
  );
}
