// @effect-diagnostics nodeBuiltinImport:off globalError:off preferSchemaOverJson:off globalFetch:off globalConsole:off - Standalone credential setup runs before the server Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

const homeFlag = process.argv.indexOf("--home-dir");
const baseDir = homeFlag >= 0 ? process.argv[homeFlag + 1] : NodePath.join(NodeOS.homedir(), ".t3");
if (!baseDir) throw new Error("--home-dir requires a directory.");
const projectId = "1ea2f814-b9d5-48ab-b427-19b4e3d384b1";
const bundleId = "com.simcity400.t3code.preview";
const expoState = JSON.parse(
  await NodeFSP.readFile(NodePath.join(NodeOS.homedir(), ".expo/state.json"), "utf8"),
) as { auth?: { sessionSecret?: string } };
if (!expoState.auth?.sessionSecret) throw new Error("Sign in to Expo with eas login first.");
const response = await fetch("https://api.expo.dev/graphql", {
  method: "POST",
  headers: { "content-type": "application/json", "expo-session": expoState.auth.sessionSecret },
  body: JSON.stringify({
    query: `query PushCredentials($id: String!) {
    app { byId(appId: $id) { iosAppCredentials {
      appleAppIdentifier { bundleIdentifier }
      pushKey { keyIdentifier keyP8 appleTeam { appleTeamIdentifier } }
    } } }
  }`,
    variables: { id: projectId },
  }),
});
if (!response.ok) throw new Error(`Expo credential lookup failed (${response.status}).`);
const result = (await response.json()) as {
  errors?: unknown;
  data?: {
    app?: {
      byId?: {
        iosAppCredentials?: Array<{
          appleAppIdentifier: { bundleIdentifier: string };
          pushKey: null | {
            keyIdentifier: string;
            keyP8: string;
            appleTeam: { appleTeamIdentifier: string };
          };
        }>;
      };
    };
  };
};
if (result.errors) throw new Error("Expo could not authorize the push credential lookup.");
const key = result.data?.app?.byId?.iosAppCredentials?.find(
  (entry) => entry.appleAppIdentifier.bundleIdentifier === bundleId,
)?.pushKey;
if (!key?.keyP8) throw new Error("This app has no downloadable Apple push key in Expo.");
NodeCrypto.createPrivateKey(key.keyP8);
const destination = NodePath.resolve(baseDir, "apple-push.json");
const contents = JSON.stringify(
  {
    bundleId,
    keyId: key.keyIdentifier,
    teamId: key.appleTeam.appleTeamIdentifier,
    privateKey: key.keyP8,
  },
  null,
  2,
);
await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
try {
  await NodeFSP.writeFile(destination, contents, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  if ((await NodeFSP.readFile(destination, "utf8")) !== contents)
    throw new Error(
      "A different Apple push configuration already exists; it has not been overwritten.",
      { cause: error },
    );
}
console.log(
  `Apple push configured for ${bundleId}. Key stored locally at ${destination}; no credential was printed.`,
);
