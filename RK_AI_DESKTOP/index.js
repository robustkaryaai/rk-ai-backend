
import express from "express";
import aiRouter from "./endpoints/ai.js";
import authRouter from "./endpoints/auth.js";
import searchRouter from "./endpoints/search.js";
import knowledgeRouter from "./endpoints/knowledge.js";

const desktopRouter = express.Router();

// Mount all desktop-specific routers under /rk-ai-desktop
desktopRouter.use("/ai", aiRouter);
desktopRouter.use("/auth", authRouter);
desktopRouter.use("/search", searchRouter);
desktopRouter.use("/knowledge", knowledgeRouter);

// Simple health check for desktop endpoints
desktopRouter.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: "RK AI Desktop Backend",
    timestamp: new Date().toISOString()
  });
});

export default desktopRouter;
