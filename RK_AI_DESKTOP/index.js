
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import aiRouter from "./endpoints/ai.js";
import authRouter from "./endpoints/auth.js";
import searchRouter from "./endpoints/search.js";
import knowledgeRouter from "./endpoints/knowledge.js";
import billingRouter from "./endpoints/billing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopRouter = express.Router();

// Serve static payment page files
desktopRouter.use(express.static(path.join(__dirname, "public")));

// Checkout Session Endpoint - returns payment page URL
desktopRouter.get("/billing/checkout", (req, res) => {
  const { slug, plan, redirect_uri } = req.query;
  
  if (!slug) {
    return res.status(400).json({ ok: false, error: "Missing slug parameter" });
  }

  // Build payment page URL
  const paymentUrl = `/rk-ai-desktop/payment.html?slug=${encodeURIComponent(slug)}&plan=${encodeURIComponent(plan || "studio")}&redirect_uri=${encodeURIComponent(redirect_uri || "rk-ai://payment-success")}`;
  
  return res.json({
    ok: true,
    paymentUrl: paymentUrl
  });
});

// Mount all desktop-specific routers under /rk-ai-desktop
desktopRouter.use("/ai", aiRouter);
desktopRouter.use("/auth", authRouter);
desktopRouter.use("/search", searchRouter);
desktopRouter.use("/knowledge", knowledgeRouter);
desktopRouter.use("/billing", billingRouter);

// Simple health check for desktop endpoints
desktopRouter.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: "RK AI Desktop Backend",
    timestamp: new Date().toISOString()
  });
});

export default desktopRouter;
