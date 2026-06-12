
# RK AI Desktop: Billing & Upgrade Frontend Integration Guide
---

## 🚀 Overview
This guide explains how to integrate your desktop checkout UI with the new backend billing endpoint!

---

## 📋 Step-by-Step Implementation

### 1. **Collect the Required Data**
In your checkout UI, ensure you have:
- The user's selected plan (`"free"`, `"core"`, `"studio"`)
- A payment token from your payment processor (e.g., Stripe's `tok_xyz`)
- The user's 9-digit device slug (from your local `config.json` or similar)

### 2. **Call the Billing Endpoint**
When the user clicks "Complete Checkout", send a `POST` request to:
```
https://rk-ai-backend.onrender.com/rk-ai-desktop/billing/upgrade
```

### 3. **Request Headers & Payload**
**Headers:**
```javascript
{
  "Content-Type": "application/json",
  "X-Device-Slug": "112175553" // Your user's device slug
}
```

**Payload (JSON):**
```javascript
{
  "plan": "studio",           // Selected plan: "free" | "core" | "studio"
  "payment_token": "tok_xyz", // Your payment processor's token
  "slug": "112175553"         // Optional, but included for redundancy
}
```

---

## 💻 Example JavaScript Code
Here's a complete example you can use directly in your desktop frontend!

```javascript
async function completeCheckout(selectedPlan, paymentToken, deviceSlug) {
  try {
    const response = await fetch("https://rk-ai-backend.onrender.com/rk-ai-desktop/billing/upgrade", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Slug": deviceSlug
      },
      body: JSON.stringify({
        plan: selectedPlan,
        payment_token: paymentToken,
        slug: deviceSlug
      })
    });

    const data = await response.json();

    if (data.ok) {
      // 1. Update local config.json with new tier
      const config = JSON.parse(localStorage.getItem("rk_ai_config") || "{}");
      config.tier = selectedPlan;
      config.unlocked_features = data.unlocked_features;
      localStorage.setItem("rk_ai_config", JSON.stringify(config));

      // 2. Show success message to user
      alert(data.message);

      // 3. Refresh UI to unlock premium features!
      refreshPremiumFeatures();
    } else {
      // Handle error
      alert(data.error || "Upgrade failed!");
    }
  } catch (err) {
    console.error("Upgrade error:", err);
    alert("Error connecting to server!");
  }
}
```

---

## 📊 Appwrite Configuration
No new columns required! The existing Devices collection already has everything:
- `slug`: 9-digit integer (primary key)
- `subscription`: String ("true" for paid, "false" for free)
- `subscription-tier`: Integer (0 = free, 1 = core, 2 = studio)

---

## 🎉 What's Next?
Once the upgrade is successful:
1. The backend updates the user's Appwrite document
2. The backend returns the list of unlocked features
3. Your desktop app can enable:
   - Priority queue for heavy tasks
   - Matrix memory (studio only)
   - Custom models (studio only)

That's it! You're ready to integrate! 🚀
