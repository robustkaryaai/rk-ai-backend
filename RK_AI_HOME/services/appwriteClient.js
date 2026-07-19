import { Client, Databases, Query, ID, Users } from "node-appwrite";
import dotenv from "dotenv";

dotenv.config(); // ✅ THIS IS CRITICAL

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)     // ✅ MUST be full URL
  .setProject(process.env.APPWRITE_PROJECT_ID)    // ✅ Project ID
  .setKey(process.env.APPWRITE_API_KEY);          // ✅ THIS WAS MISSING

export const db = new Databases(client);
export const users = new Users(client);

async function logAppwriteStructureError(context, err, payload = {}) {
  const details = {
    file: "RK_AI_HOME/services/appwriteClient.js",
    ...context,
    appwrite: {
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      databaseId: process.env.APPWRITE_DB_ID,
      collectionId: process.env.APPWRITE_DEVICES_COLLECTION,
    },
    payloadKeys: Object.keys(payload),
    code: err?.code,
    type: err?.type,
    message: err?.message,
    response: err?.response,
  };

  if (err?.type === "document_invalid_structure") {
    try {
      const attributes = await db.listAttributes(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION
      );
      details.collectionAttributes = attributes.attributes?.map((attribute) => ({
        key: attribute.key,
        type: attribute.type,
        status: attribute.status,
        required: attribute.required,
        array: attribute.array,
      }));
      details.hasSubscriptionExpiresAt = details.collectionAttributes.some(
        (attribute) => attribute.key === "subscription_expires_at"
      );
    } catch (attrErr) {
      details.attributeLookupError = {
        code: attrErr?.code,
        type: attrErr?.type,
        message: attrErr?.message,
        response: attrErr?.response,
      };
    }
  }

  console.error("[Appwrite document structure culprit]", JSON.stringify(details, null, 2));
}

export async function getUserPlanBySlug(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))] // ✅ string slug
  );

  if (!res.documents.length) {
    throw new Error("Invalid slug");
  }

  return res.documents[0];
}

export async function checkDeviceBySlug(slug) {
  const numSlug = Number(slug);
  if (isNaN(numSlug)) return false; // Not a valid Appwrite number slug
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", numSlug)]
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

  const payload = {
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
  };

  try {
    await db.createDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      ID.unique(),
      payload
    );
  } catch (err) {
    await logAppwriteStructureError(
      {
        function: "ensureDeviceBySlug",
        action: "createDocument",
        culpritLine: "createDocument payload includes subscription_expires_at",
        slug: Number(slug),
        deviceType,
      },
      err,
      payload
    );
    throw err;
  }

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

// ── CUSTOM USERS DATABASE COLLECTION HELPERS ──────────────────────
export async function getDatabaseUserByEmail(email) {
  const usersCollection = process.env.APPWRITE_USERS_COLLECTION || "users";
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    usersCollection,
    [Query.equal("email", String(email))]
  );
  if (res.documents.length > 0) return res.documents[0];
  return null;
}

export async function createDatabaseUser(email, name, avatar) {
  const usersCollection = process.env.APPWRITE_USERS_COLLECTION || "users";
  const slug = Math.floor(100000000 + Math.random() * 900000000); // 9 digit random integer
  return await db.createDocument(
    process.env.APPWRITE_DB_ID,
    usersCollection,
    ID.unique(),
    {
      email: String(email),
      name: String(name || email.split("@")[0]),
      avatar: avatar || "",
      slug: Number(slug),
      plan: "free"
    }
  );
}

export async function upgradeDatabaseUser(email, plan, durationDays = 30) {
  const usersCollection = process.env.APPWRITE_USERS_COLLECTION || "users";
  const userDoc = await getDatabaseUserByEmail(email);
  if (!userDoc) throw new Error("User not found in database users collection");

  const now = new Date();
  let expiresAt = null;
  if (plan !== "free") {
    expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const appwritePlanMap = { free: "free", pro: "core", elite: "apex" };
  const dbPlan = appwritePlanMap[plan] || "free";

  await db.updateDocument(
    process.env.APPWRITE_DB_ID,
    usersCollection,
    userDoc.$id,
    {
      plan: dbPlan
    }
  );

  return userDoc.slug; // Return the slug to update the devices collection
}
