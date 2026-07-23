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
  const numSlug = Number(slug);
  if (isNaN(numSlug)) {
    throw new Error("Invalid slug: not a number");
  }
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", numSlug)] // ✅ string slug
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

// Get subscription status for a slug (Ultra-Robust Rewrite)
export async function getSubscriptionStatus(slug, email) {
  await ensureDeviceBySlug(slug, "desktop");
  const device = await getUserPlanBySlug(slug);
  const now = new Date();
  
  const tierMap = { "free": 0, "pro": 1, "elite": 2, "quantum": 3, "infinity": 4 };
  const revTierMap = { 0: "free", 1: "pro", 2: "elite", 3: "quantum", 4: "infinity" };

  let highestTier = 0;
  let isActive = false;
  let expiresAt = null;

  // 1. Check Device Collection (Base Tier)
  if (device.subscription === "true") {
    if (device.subscription_expires_at) {
      if (new Date(device.subscription_expires_at) > now) {
        highestTier = Math.max(highestTier, Number(device["subscription-tier"] || 0));
        isActive = true;
        expiresAt = device.subscription_expires_at;
      }
    } else {
      highestTier = Math.max(highestTier, Number(device["subscription-tier"] || 0));
      isActive = true;
    }
  }

  // 2. Sync with Subscriptions Collection (Stripe/Billing tier)
  if (email) {
    try {
      const subs = await db.listDocuments(
        process.env.APPWRITE_DB_ID,
        "subscriptions",
        [Query.equal("userId", String(email))]
      );
      if (subs.documents.length > 0) {
        const sub = subs.documents[0];
        if (sub.status === "active") {
          const subTier = tierMap[sub.plan] || 0;
          if (subTier > highestTier) {
            highestTier = subTier;
            isActive = true;
            expiresAt = sub.expiresOn || null;
          }
        }
      }
    } catch (e) {
      console.warn("[Robust Sync] Subscriptions error:", e.message);
    }
  }

  // 3. Sync with Users Collection (Legacy Web Accounts)
  if (email) {
    try {
      const usersCol = process.env.APPWRITE_USERS_COLLECTION || "users";
      const usr = await db.listDocuments(
        process.env.APPWRITE_DB_ID,
        usersCol,
        [Query.equal("email", String(email))]
      );
      if (usr.documents.length > 0) {
        const u = usr.documents[0];
        const uTier = tierMap[u.plan] || 0;
        if (uTier > highestTier) {
          highestTier = uTier;
          isActive = true;
        }
      }
    } catch (e) {
      console.warn("[Robust Sync] Users error:", e.message);
    }
  }

  // 4. Force Update Device if out of sync
  if ((isActive && device.subscription !== "true") || Number(device["subscription-tier"]) !== highestTier) {
    try {
      await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        device.$id,
        {
          subscription: highestTier > 0 ? "true" : "false",
          "subscription-tier": highestTier
        }
      );
    } catch(e) {}
  }

  // 5. Handle Monthly Reset
  if (device.usageResetAt && new Date(device.usageResetAt) <= now) {
    const nextReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      { tokensUsed: 0, imagesUsed: 0, videosUsed: 0, usageResetAt: nextReset }
    );
    device.tokensUsed = 0; device.imagesUsed = 0; device.videosUsed = 0;
  }

  // Calculate Days Left
  let daysLeft = isActive ? 9999 : 0;
  if (expiresAt && isActive) {
    daysLeft = Math.max(0, Math.ceil((new Date(expiresAt) - now) / (1000 * 60 * 60 * 24)));
  }

  let finalPlan = revTierMap[highestTier] || "free";
  
  // 6. Legacy fallback check for desktopPlan field
  if (highestTier === 0) {
    const legacyPlan = device.desktopPlan || device.desktop_plan;
    if (legacyPlan && legacyPlan !== "free") {
      finalPlan = legacyPlan;
      isActive = true;
      highestTier = tierMap[legacyPlan] || 1;
    }
  }

  return {
    status: isActive ? "active" : "expired",
    plan: finalPlan,
    tier: highestTier,
    days_left: daysLeft,
    expires_at: expiresAt,
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

  const dbPlan = plan || "free";

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
