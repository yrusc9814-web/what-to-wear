import { access, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalShared = path.join(projectRoot, "cloudfunctions", "shared");
const mutationFunctions = [
  "saveClothing",
  "updateClothing",
  "deleteClothing",
  "saveOutfit",
  "updateSavedOutfit",
  "deleteOutfitRecord",
  "saveOutfitReference",
  "updateOutfitReference",
  "deleteOutfitReference"
];

await access(canonicalShared);

for (const functionName of mutationFunctions) {
  const targetShared = path.join(projectRoot, "cloudfunctions", functionName, "shared");
  await rm(targetShared, { recursive: true, force: true });
  await cp(canonicalShared, targetShared, { recursive: true });
}

console.log(`Prepared generated shared copies for ${mutationFunctions.length} mutation cloud functions.`);
