import { createProfessionalDocx } from "./officeGenerator.js";

export async function createDocx(prompt, slug) {
  return await createProfessionalDocx(prompt, slug, "document");
}
