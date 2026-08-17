import re

with open("RK_AI_DESKTOP/endpoints/ai.js", "r") as f:
    code = f.read()

# For image
old_img = """    logInfo(`Desktop Image Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    const result = await generateImage(prompt, slug, tier, storageMB);"""

new_img = """    logInfo(`Desktop Image Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    
    const quotaCheck = await checkAndConsume(slug, tier, "image", 1);
    if (!quotaCheck.ok) {
        logWarn(`❌ QUOTA EXCEEDED for ${slug}: Image Generation limit reached.`);
        return res.status(403).json({ ok: false, error: "RK AI Quota Exceeded. You have reached your Image Generation limit." });
    }
    
    const result = await generateImage(prompt, slug, tier, storageMB);"""

code = code.replace(old_img, new_img)

# For video
old_vid = """    logInfo(`Desktop Video Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    const result = await generateVideo(prompt, slug, tier, storageMB, req.body);"""

new_vid = """    logInfo(`Desktop Video Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    
    const quotaCheck = await checkAndConsume(slug, tier, "video", 1);
    if (!quotaCheck.ok) {
        logWarn(`❌ QUOTA EXCEEDED for ${slug}: Video Generation limit reached.`);
        return res.status(403).json({ ok: false, error: "RK AI Quota Exceeded. You have reached your Video Generation limit." });
    }
    
    const result = await generateVideo(prompt, slug, tier, storageMB, req.body);"""

code = code.replace(old_vid, new_vid)

with open("RK_AI_DESKTOP/endpoints/ai.js", "w") as f:
    f.write(code)
print("Patched ai.js limits")
