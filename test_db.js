import dotenv from 'dotenv';
dotenv.config();
import { getUserPlanBySlug } from './RK_AI_HOME/services/appwriteClient.js';
async function run() {
  const doc = await getUserPlanBySlug('268968813');
  console.log(JSON.stringify(doc, null, 2));
}
run();
