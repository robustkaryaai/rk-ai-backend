import { ID, Query } from "node-appwrite";
import { db } from "./appwriteClient.js";

const WAITLIST_COLLECTION_ID = "waitlist";

function cleanText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function normalizeDevicesWanted(value) {
  return cleanText(value, "");
}

function normalizeWaitlistEntry(doc) {
  if (!doc) return null;
  return {
    id: doc.$id,
    name: doc.name || "",
    email: doc.email || "",
    region: doc.country || "",
    devicesWanted: doc.notes || "",
    product: doc.product || "",
    productKey: doc.productKey || "",
    userId: doc.userId || "",
    createdAt: doc.createdAt || doc.$createdAt || "",
    updatedAt: doc.$updatedAt || "",
  };
}

export async function listWaitlistEntries({ userId = "", email = "", productKey = "" } = {}) {
  const normalizedProductKey = cleanText(productKey, "rexycore");
  const normalizedUserId = cleanText(userId, "");
  const normalizedEmail = cleanText(email, "");
  const queries = [Query.equal("productKey", normalizedProductKey), Query.orderDesc("$createdAt"), Query.limit(50)];
  const results = [];
  const seen = new Set();

  async function addMatches(extraQuery) {
    const response = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      WAITLIST_COLLECTION_ID,
      [...extraQuery, ...queries],
    ).catch(() => ({ documents: [] }));

    for (const doc of response.documents || []) {
      if (!doc?.$id || seen.has(doc.$id)) continue;
      seen.add(doc.$id);
      results.push(doc);
    }
  }

  if (normalizedUserId && normalizedUserId !== "anonymous") {
    await addMatches([Query.equal("userId", normalizedUserId)]);
  }

  if (normalizedEmail) {
    await addMatches([Query.equal("email", normalizedEmail)]);
  }

  return results;
}

export async function findWaitlistEntry({ userId = "", email = "", productKey = "" } = {}) {
  const normalizedProductKey = cleanText(productKey, "rexycore");
  const normalizedUserId = cleanText(userId, "");
  const normalizedEmail = cleanText(email, "");

  const baseQueries = [Query.equal("productKey", normalizedProductKey), Query.orderDesc("$createdAt"), Query.limit(1)];

  if (normalizedUserId && normalizedUserId !== "anonymous") {
    const byUser = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      WAITLIST_COLLECTION_ID,
      [Query.equal("userId", normalizedUserId), ...baseQueries],
    );
    if (byUser.documents?.length) return byUser.documents[0];
  }

  if (normalizedEmail) {
    const byEmail = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      WAITLIST_COLLECTION_ID,
      [Query.equal("email", normalizedEmail), ...baseQueries],
    );
    if (byEmail.documents?.length) return byEmail.documents[0];
  }

  return null;
}

export async function getWaitlistStatus({ userId = "", email = "", productKey = "" } = {}) {
  const entry = await findWaitlistEntry({ userId, email, productKey });
  return {
    ok: true,
    joined: Boolean(entry),
    entry: normalizeWaitlistEntry(entry),
  };
}

export async function upsertWaitlistEntry(payload = {}) {
  const name = cleanText(payload.name, "Anonymous");
  const email = cleanText(payload.email, "");
  const phone = cleanText(payload.phone, "");
  const region = cleanText(payload.country || payload.region, "India");
  const product = cleanText(payload.product, "Rexycore");
  const productKey = cleanText(payload.productKey, "rexycore");
  const userId = cleanText(payload.userId, "anonymous");
  const paymentIntent = cleanText(payload.paymentIntent, "Maybe");
  const notes = normalizeDevicesWanted(payload.notes || payload.featureDemand);

  if (!email) {
    throw new Error("Email required");
  }

  const existing = await findWaitlistEntry({ userId, email, productKey });
  const documentData = {
    name,
    email,
    phone,
    country: region,
    product,
    productKey,
    userId,
    paymentIntent,
    notes,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  const saved = existing
    ? await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        WAITLIST_COLLECTION_ID,
        existing.$id,
        documentData,
      )
    : await db.createDocument(
        process.env.APPWRITE_DB_ID,
        WAITLIST_COLLECTION_ID,
        ID.unique(),
        documentData,
      );

  return {
    ok: true,
    joined: true,
    created: !existing,
    message: existing ? "Waitlist details updated." : "You are now on the waitlist.",
    entry: normalizeWaitlistEntry(saved),
  };
}
