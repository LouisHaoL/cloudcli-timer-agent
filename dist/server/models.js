/**
 * Model options for the job form's model picker, read from the host's own
 * provider modules (`~/.cloudcli/server/<version>/dist-server/.../providers/
 * list/<tool>/<tool>-models.provider.js`) — the same curated lists the host's
 * new-session selector renders, so both stay in lockstep across host
 * upgrades. Each module is imported dynamically; any failure (host not
 * installed, layout change) falls back per-tool to the plugin catalog.
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_TOOLS } from '../shared/agents.js';
/**
 * User-created models the host persists in its SQLite app db (`provider_models`
 * — the rows added through CloudUI's provider settings, e.g. GLM aliases over
 * a proxy). Read via the built-in `node:sqlite`; any failure (older Node, db
 * elsewhere) just means predefined lists only. Same merge order as the host:
 * predefined first, custom appended.
 */
async function readCustomModels() {
    const map = new Map();
    try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(homedir(), '.cloudcli', 'auth.db'), { readOnly: true });
        try {
            const rows = db.prepare('SELECT provider, model_id, model_name FROM provider_models ORDER BY sort_order ASC, lower(model_name) ASC, id ASC').all();
            for (const row of rows) {
                if (typeof row.provider !== 'string' || typeof row.model_id !== 'string' || row.model_id === '')
                    continue;
                const label = typeof row.model_name === 'string' && row.model_name !== '' ? row.model_name : row.model_id;
                const list = map.get(row.provider) ?? [];
                list.push({ value: row.model_id, label, custom: true });
                map.set(row.provider, list);
            }
        }
        finally {
            db.close();
        }
    }
    catch {
        // Predefined lists only.
    }
    return map;
}
/** Re-read the host modules at most this often (imports are URL-cached, the dir scan is not). */
const CACHE_TTL_MS = 60_000;
let cache;
/** Latest host install whose dist-server carries the provider list modules. */
async function resolveListRoot() {
    const root = join(homedir(), '.cloudcli', 'server');
    let versions;
    try {
        versions = await readdir(root);
    }
    catch {
        return undefined;
    }
    const candidates = [];
    for (const name of versions) {
        if (name.startsWith('.'))
            continue;
        const dir = join(root, name, 'dist-server', 'server', 'modules', 'providers', 'list');
        try {
            candidates.push({ dir, mtime: (await stat(dir)).mtimeMs });
        }
        catch {
            continue;
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.dir;
}
/** Import one tool's predefined list; null results degrade to the catalog entry. */
async function loadToolModels(tool, root) {
    const fallback = {
        options: tool.models.map(model => ({ value: model, label: model })),
        ...(tool.defaultModel !== undefined ? { default: tool.defaultModel } : {}),
    };
    if (root === undefined)
        return fallback;
    try {
        const file = join(root, tool.id, `${tool.id}-models.provider.js`);
        const mod = await import(pathToFileURL(file).href);
        const list = mod[`${tool.id.toUpperCase()}_PREDEFINED_MODELS`];
        if (list === undefined || !Array.isArray(list.OPTIONS))
            return fallback;
        const options = list.OPTIONS
            .filter((option) => typeof option?.value === 'string' && option.value !== '')
            .map(option => ({
            value: option.value,
            label: typeof option.label === 'string' && option.label !== '' ? option.label : option.value,
        }));
        if (options.length === 0)
            return fallback;
        return {
            options,
            ...(typeof list.DEFAULT === 'string' && list.DEFAULT !== '' ? { default: list.DEFAULT } : {}),
        };
    }
    catch {
        return fallback;
    }
}
/** Model options per tool id (cached; each tool degrades independently). */
export async function listHostModels() {
    if (cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS)
        return cache.models;
    const root = await resolveListRoot();
    const custom = await readCustomModels();
    const models = {};
    for (const tool of AGENT_TOOLS) {
        const base = await loadToolModels(tool, root);
        const extra = custom.get(tool.id) ?? [];
        const options = [...base.options];
        for (const option of extra) {
            if (!options.some(existing => existing.value === option.value))
                options.push(option);
        }
        models[tool.id] = { options, ...(base.default !== undefined ? { default: base.default } : {}) };
    }
    cache = { at: Date.now(), models };
    return models;
}
//# sourceMappingURL=models.js.map