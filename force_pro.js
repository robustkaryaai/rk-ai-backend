import dotenv from "dotenv";
dotenv.config();

async function run() {
  const { updateSubscription } = await import("./RK_AI_HOME/services/appwriteClient.js");
  console.log("Forcing PRO...");
  try {
    await updateSubscription("901300825", "pro", 3650);
    console.log("Success! Device upgraded to Pro.");
  } catch (err) {
    console.error("Failed:", err);
  }
  process.exit(0);
}
run();
