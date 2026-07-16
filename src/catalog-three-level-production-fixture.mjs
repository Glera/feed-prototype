import { createHash } from 'node:crypto';

const EXPECTED_CONTENT_HASH =
  '2c0efd621a0acddeadc395b1f285bc9242043481a60264b001b70faf10601ccc';

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

/** RFC 8785-compatible for this integer/string/array/object fixture. */
export const jcsCanonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcsCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${jcsCanonicalJson(value[key])}`,
  ).join(',')}}`;
};

export const sha256Jcs = (value) => createHash('sha256')
  .update(jcsCanonicalJson(value))
  .digest('hex');

const manifest = {
  schema: 'series.manifest.v2',
  mechanic: 'sort',
  variant: 'base',
  levels: [
    '3c93d8321bb80133d77d83bc9fbbd6530409ca6f0056147a5f49b63cc1f5728c',
    'b1e7ca54b041f3ff7525475bc775260d9133029a50f06e24a3a898dfc7258cf3',
    '64586c03364ba5b756ca02abbcafc46e8425277369f53aeef90aff1b3ca55023',
  ],
  arcTags: [],
  difficultyCurve: [
    'sort.oracle-effort.v1:909',
    'sort.oracle-effort.v1:1536',
    'sort.oracle-effort.v1:2493',
  ],
  seriesSeed: 1527370152,
  acceptedEvaluations: [
    '466d2398-0039-4bb0-a9db-3348f82eb06b',
    'dc39acf6-41ef-4193-a8bc-b49891f4ef9e',
    '5e168a54-db98-4b54-b80e-3ae84b43224d',
  ],
  skinHash: 'fc52556cfb44cd2fa6509b62ac6fa9a34bfbbb0abab2a13fc767ba251b6f5586',
  gameplayFingerprint: '8c577a70f688f03e3a29b515629d622b91dda2a4810f4071ad77e38ac7a35d6b',
  presentationFingerprint: 'd8ca1e47dd72ad9910816615c952d62dc66454dd7c434464ee5d1ce3a5892ac7',
  compat: {
    runtimeArtifactDigest: 'sha256:8056dcb3c3ff465da923fbb55fce015fa1f8a3820961885b668aad6027b3ea28',
    oracleVersion: 'sha256:d6619eafb2cd2e0123055886771228df3149f2f8c8ffb46c261a3b0706287af1',
  },
};

const specs = [
  {
    schema: 'sort.level-spec.v1',
    specHash: manifest.levels[0],
    runtimeContractDigest: 'c79a84694f02dad356822fa1b3f3d039b8f056f23f1300ff536a072e54c3b625',
    seed: 1005,
    params: {
      gridCols: 6,
      gridRows: 5,
      colorsUsed: 3,
      cellColorMap: [0, 0, 2, 1, 0, 1, 2, 2, 2, 2, 0, 2, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 1, 0, 2, 0, 0, 1, 1, 1],
      targetStacks: [[0], [1], [2], [0]],
      convSpeedMul: 0.8,
      modifiers: [],
    },
  },
  {
    schema: 'sort.level-spec.v1',
    specHash: manifest.levels[1],
    runtimeContractDigest: 'c79a84694f02dad356822fa1b3f3d039b8f056f23f1300ff536a072e54c3b625',
    seed: 2004,
    params: {
      gridCols: 7,
      gridRows: 6,
      colorsUsed: 4,
      cellColorMap: [0, 0, 2, 3, 0, 3, 2, 2, 1, 0, 1, 2, 0, 2, 2, 2, 1, 1, 3, 0, 3, 3, 0, 0, 3, 3, 3, 2, 1, 2, 1, 3, 2, 1, 0, 0, 3, 3, 1, 1, 1, 0],
      targetStacks: [[3, 2], [0, 3], [1, 2], [0, 1]],
      convSpeedMul: 1,
      modifiers: [],
    },
  },
  {
    schema: 'sort.level-spec.v1',
    specHash: manifest.levels[2],
    runtimeContractDigest: 'c79a84694f02dad356822fa1b3f3d039b8f056f23f1300ff536a072e54c3b625',
    seed: 137,
    params: {
      gridCols: 8,
      gridRows: 7,
      colorsUsed: 6,
      cellColorMap: [2, 1, 4, 3, 0, 1, 5, 3, 1, 0, 0, 2, 1, 0, 4, 3, 3, 1, 1, 0, 4, 5, 2, 1, 2, 4, 1, 4, 4, 3, 2, 2, 0, 3, 2, 5, 5, 0, 4, 5, 2, 3, 3, 5, 5, 3, 5, 4, 4, 5, 1, 0, 1, 2, 2, 0],
      targetStacks: [[4, 1], [4, 3], [0, 2], [5, 5]],
      convSpeedMul: 1,
      modifiers: [],
    },
  },
];

const skin = {
  schema: 'sort.skin-spec.v1',
  skinContractDigest: '46594a810964e5ea7a0e9a06af7a370943f98f5616009f1a0123809704f35671',
  skinHash: manifest.skinHash,
  params: {
    marbleStyle: 'glass',
    markerStyle: 'rings',
    targetShape: 'jar',
    sourceShape: 'flask',
    backgroundPattern: 'stars',
    sceneColors: {
      ground: '#F5C2DC',
      edge: '#9A6CAF',
      sceneBg: '#FFEAF5',
      boardBg: '#EBC8F2',
      belt: '#C89FD9',
      outline: '#7F5B91',
    },
    roleDisplayColors: ['#FF7B7B', '#B07BFF', '#5BC8D8', '#7BE87B', '#F5C842', '#FF9F43'],
  },
};

const contentHash = sha256Jcs(manifest);
if (contentHash !== EXPECTED_CONTENT_HASH) {
  throw new Error(`exact production manifest drift: ${contentHash}`);
}
if (specs.some((spec, index) => spec.specHash !== manifest.levels[index])) {
  throw new Error('exact production spec order drift');
}
if (skin.skinHash !== manifest.skinHash) throw new Error('exact production skin drift');

const seriesFingerprint = sha256Jcs({
  gameplayFingerprint: manifest.gameplayFingerprint,
  presentationFingerprint: manifest.presentationFingerprint,
});

export const EXACT_THREE_LEVEL_PRODUCTION_FIXTURE = deepFreeze({
  schema: 'catalog.three-level-production-fixture.v1',
  provenance: {
    draftRevisionId: '66998ed0-c310-4036-83a1-7dd2ace52e32',
    seriesReviewId: '30f68918-ff6b-4169-84d9-d0620f26e525',
  },
  contentHash,
  manifest,
  specs,
  skin,
  seriesFingerprint,
  fingerprintVersion: 'series.fingerprint.v2',
});

export const EXACT_THREE_LEVEL_CONTENT_HASH = contentHash;
export const EXACT_THREE_LEVEL_SPEC_HASHES = deepFreeze([...manifest.levels]);
export const EXACT_THREE_LEVEL_SKIN_HASH = skin.skinHash;
export const EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST = skin.skinContractDigest;
export const EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST = specs[0].runtimeContractDigest;
export const EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST = manifest.compat.runtimeArtifactDigest;
