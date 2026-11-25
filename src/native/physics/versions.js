'use strict';
// Version differences of the vanilla player movement as data (TASK-20261125-076, docs/proposed/NATIVE-v1.md). Nothing else in src/native/physics names a
// version: the tick reads a feature set built here from the connected version's data version (minecraft-data `version.dataVersion`).
//
// Each entry: the first data version that has the behaviour, and how sure we are. `verified: false` marks behaviour written from the decompiled game as
// remembered, not yet checked against a server trace (docs/proposed/NATIVE-v1.md, "Trace format"): stage B checks each one on the 1.21.1 test worlds.

// data versions of the releases named below (minecraft-data `version.dataVersion`)
const DV = { '1.20.1': 3465, '1.20.5': 3837, '1.21': 3953, '1.21.1': 3955, '1.21.2': 4080, '1.21.4': 4189, '1.21.5': 4325 };

const FEATURES = [
    // Player.maybeBackOffFromEdge: before 1.20.5 the probe box is the player's box moved down by maxUpStep; from 1.20.5 a thin box under the feet that
    // reaches maxUpStep + 1e-5 down (canFallAtLeast), and isAboveGround also accepts a body that has fallen less than maxUpStep.
    { name: 'edgeProbeBelowFeet', since: DV['1.20.5'], verified: false },
    // LivingEntity.jumpFromGround keeps a larger upward speed (Math.max(jumpPower, v.y)) since the wind charge (1.20.5 / 1.21).
    { name: 'jumpKeepsUpwardSpeed', since: DV['1.20.5'], verified: false },
    // Attribute modifiers carry a resource id (minecraft:sprinting) instead of a UUID.
    { name: 'modifierIds', since: DV['1.20.5'], verified: true },
    // Entity.collide: 1.21.2 replaced the two-candidate step-up with the candidate heights of the colliders (collectCandidateStepUpHeights).
    { name: 'stepCandidates', since: DV['1.21.2'], verified: false },
    // Mth.sin/cos take a double from 1.21.2 (the table index from d * 10430.378350470453), a float before.
    { name: 'mthDouble', since: DV['1.21.2'], verified: false },
    // The movement input vector is normalised (diagonal keys no faster than straight ones) from 1.21.5 (KeyboardInput.moveVector).
    { name: 'normalisedInput', since: DV['1.21.5'], verified: false },
];

/** The feature set of a data version: { edgeProbeBelowFeet: bool, ... , dataVersion }. */
function featuresOf(dataVersion) {
    const out = { dataVersion };
    for (const f of FEATURES) out[f.name] = dataVersion >= f.since;
    return out;
}

/** Data version of a minecraft-data / prismarine-registry object, or of a version string through minecraft-data. */
function dataVersionOf(registryOrVersion) {
    if (registryOrVersion && registryOrVersion.version && Number.isInteger(registryOrVersion.version.dataVersion)) return registryOrVersion.version.dataVersion;
    if (typeof registryOrVersion === 'string') {
        if (DV[registryOrVersion]) return DV[registryOrVersion];
        const md = require('minecraft-data')(registryOrVersion);
        if (md && md.version && Number.isInteger(md.version.dataVersion)) return md.version.dataVersion;
    }
    throw new Error(`native physics: unknown version ${JSON.stringify(registryOrVersion && registryOrVersion.version ? registryOrVersion.version : registryOrVersion)}`);
}

module.exports = { FEATURES, DV, featuresOf, dataVersionOf };
