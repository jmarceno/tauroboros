// Placeholder - run compile script to regenerate

export type EmbeddedAsset = { contentType: string; isText: boolean; data: string }

export interface GeneratedAssetsModule {
  getEmbeddedAsset(path: string): EmbeddedAsset | null
  listEmbeddedAssets(): string[]
  getIndexHtml(): string
  getAllSkillAssets(): Array<{ path: string; asset: EmbeddedAsset }>
  getAllConfigAssets(): Array<{ path: string; asset: EmbeddedAsset }>
  getAllDockerAssets(): Array<{ path: string; asset: EmbeddedAsset }>
}

export const getEmbeddedAsset: GeneratedAssetsModule["getEmbeddedAsset"] | undefined = undefined
export const listEmbeddedAssets: GeneratedAssetsModule["listEmbeddedAssets"] | undefined = undefined
export const getIndexHtml: GeneratedAssetsModule["getIndexHtml"] | undefined = undefined
export const getAllSkillAssets: GeneratedAssetsModule["getAllSkillAssets"] | undefined = undefined
export const getAllConfigAssets: GeneratedAssetsModule["getAllConfigAssets"] | undefined = undefined
export const getAllDockerAssets: GeneratedAssetsModule["getAllDockerAssets"] | undefined = undefined
