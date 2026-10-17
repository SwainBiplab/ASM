/**
 * Lowers the asset-code digit-padding minimum from 3 to 2, matching the corresponding relaxation
 * of `assetCodeConfigSchema`'s `padding` validation in src/shared/assetSchemas.ts. Never edit an
 * applied migration; the original CHECK (0004_assets.ts) stays as historical record.
 */
export const migration0012 = {
  version: 12,
  name: 'asset_code_padding_min',
  sql: `
ALTER TABLE asset_code_config DROP CONSTRAINT asset_code_config_padding_check;
ALTER TABLE asset_code_config ADD CONSTRAINT asset_code_config_padding_check CHECK (padding BETWEEN 2 AND 10);
`
} as const
