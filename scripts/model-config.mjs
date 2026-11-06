export class VaultError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const validKey=key=>typeof key==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+$/.test(key)&&!key.split('/').some(s=>s==='.'||s==='..');
// The standalone agent has no vault implementation or direct secret access tools.
export function createVault(){return async()=>{throw new VaultError('独立章鱼不提供直接仓库接口，请使用门神 MCP 工具',403);};}
