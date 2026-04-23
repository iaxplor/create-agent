// Parse e validação do `template.json` de um módulo (após download).
//
// O schema de um módulo é SUPERSET do template core — tem campos adicionais
// (`requires`, `min_core_version`, `files[]`, `patches[]`). Esta função valida
// que os campos obrigatórios estão presentes e com tipo correto, devolvendo
// erro claro no primeiro problema encontrado.

import path from "node:path";

import fsExtra from "fs-extra";

import type { FileMapping, ModuleTemplateJson, PatchDescription } from "../types.js";
import { InternalError, UserError } from "./errors.js";

const { pathExists, readJson } = fsExtra;

/** Lê e valida `template.json` de um módulo já baixado pra temp.
 *
 *  `moduleTmpDir` é o path absoluto retornado por `fetchModuleToTemp`.
 */
export async function parseModuleManifest(
  moduleTmpDir: string,
): Promise<ModuleTemplateJson> {
  const manifestPath = path.join(moduleTmpDir, "template.json");

  if (!(await pathExists(manifestPath))) {
    throw new UserError(
      "Módulo inválido: arquivo 'template.json' não encontrado após download.",
    );
  }

  let raw: unknown;
  try {
    raw = await readJson(manifestPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Falha ao parsear template.json do módulo: ${msg}`);
  }

  return validateManifest(raw);
}

/** Valida a estrutura do objeto parseado e devolve tipado.
 *
 *  Checagens são "rasas" — cada campo obrigatório tem tipo certo, arrays não
 *  estão vazios onde faz diferença, etc. Não validamos semver aqui (fica em
 *  `version-check`) nem presença física dos `files[]` (fica no installer).
 */
function validateManifest(raw: unknown): ModuleTemplateJson {
  if (!isPlainObject(raw)) {
    throw new UserError("template.json do módulo: esperado objeto JSON no topo.");
  }

  const name = requireString(raw, "name");
  const version = requireString(raw, "version");
  const description = requireString(raw, "description");
  const requires = requireStringArray(raw, "requires");
  const minCore = requireString(raw, "min_core_version");
  const dependencies = requireStringArray(raw, "dependencies");
  const envVars = requireArray(raw, "env_vars").map((v, i) =>
    validateEnvVar(v, i),
  );
  const files = requireArray(raw, "files").map((f, i) => validateFileMapping(f, i));
  const patches = requireArray(raw, "patches").map((p, i) =>
    validatePatch(p, i),
  );

  // Campo opcional — presente a partir da convenção v0.3.0 do CLI.
  // Templates legados (sem setup_doc) funcionam normalmente via convenção.
  const setupDoc =
    typeof raw.setup_doc === "string" && raw.setup_doc.length > 0
      ? raw.setup_doc
      : undefined;

  return {
    name,
    version,
    description,
    requires,
    min_core_version: minCore,
    dependencies,
    env_vars: envVars,
    files,
    patches,
    setup_doc: setupDoc,
  };
}

// --------------------------------------------------------------------------- //
//  Validadores granulares
// --------------------------------------------------------------------------- //

function validateEnvVar(
  raw: unknown,
  index: number,
): ModuleTemplateJson["env_vars"][number] {
  if (!isPlainObject(raw)) {
    throw new UserError(`template.json: env_vars[${index}] deve ser objeto.`);
  }
  const name = requireString(raw, "name", `env_vars[${index}]`);
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const required = typeof raw.required === "boolean" ? raw.required : undefined;
  // Campo opcional (v0.3.0+). Templates legados sem `default` → undefined,
  // e o env-example-editor gera linha vazia (`VAR=`). Degradação graciosa.
  const defaultValue = typeof raw.default === "string" ? raw.default : undefined;
  return { name, description, required, default: defaultValue };
}

function validateFileMapping(raw: unknown, index: number): FileMapping {
  if (!isPlainObject(raw)) {
    throw new UserError(`template.json: files[${index}] deve ser objeto.`);
  }
  const from = requireString(raw, "from", `files[${index}]`);
  const to = requireString(raw, "to", `files[${index}]`);
  return { from, to };
}

function validatePatch(raw: unknown, index: number): PatchDescription {
  if (!isPlainObject(raw)) {
    throw new UserError(`template.json: patches[${index}] deve ser objeto.`);
  }
  const file = requireString(raw, "file", `patches[${index}]`);
  const description = requireString(raw, "description", `patches[${index}]`);
  return { file, description };
}

// --------------------------------------------------------------------------- //
//  Helpers primitivos (sem dep externa de schema)
// --------------------------------------------------------------------------- //

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  context = "template.json",
): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new UserError(`${context}: campo '${field}' obrigatório (string).`);
  }
  return v;
}

function requireArray(
  obj: Record<string, unknown>,
  field: string,
  context = "template.json",
): unknown[] {
  const v = obj[field];
  if (!Array.isArray(v)) {
    throw new UserError(`${context}: campo '${field}' obrigatório (array).`);
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  field: string,
  context = "template.json",
): string[] {
  const arr = requireArray(obj, field, context);
  if (!arr.every((v) => typeof v === "string")) {
    throw new UserError(
      `${context}: campo '${field}' deve ser array de strings.`,
    );
  }
  return arr as string[];
}
