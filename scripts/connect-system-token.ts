/**
 * Connect an Instagram account with a Unified login system-user token (EAA…),
 * for apps that no longer offer "API setup with Instagram login" and so
 * cannot use the OAuth button in Settings.
 *
 *   IG_TOKEN=EAA... npx tsx scripts/connect-system-token.ts you@example.com 1784...
 *
 * Without IG_TOKEN it asks for the token on stdin. Requires
 * META_GRAPH_HOST=graph.facebook.com on the web app and worker. Sign in once
 * first, so the email already owns a workspace.
 */
import { createInterface } from "node:readline/promises";
import { prisma } from "@/lib/db/client";
import { getUserInfo } from "@/lib/meta/client";
import { encryptToken } from "@/lib/meta/oauth";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";

async function readToken() {
  if (process.env.IG_TOKEN) return process.env.IG_TOKEN.trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = (await rl.question("Token (EAA...): ")).trim();
  rl.close();
  return token;
}

async function main() {
  const [email, instagramId] = process.argv.slice(2);
  if (!email || !instagramId) {
    throw new Error("Usage: npx tsx scripts/connect-system-token.ts <email> <instagram-account-id>");
  }
  if (!process.env.META_GRAPH_HOST) {
    throw new Error("Set META_GRAPH_HOST=graph.facebook.com first; system-user tokens fail on graph.instagram.com");
  }

  const workspace = await prisma.workspace.findFirst({
    where: { owner: { email: email.toLowerCase() } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (!workspace) throw new Error(`No workspace owned by ${email}. Sign in once first.`);

  const token = await readToken();
  if (!token) throw new Error("Empty token");

  // Proves the token can read this account before anything is stored.
  const info = await getUserInfo(token, instagramId);

  const connection = await canConnectInstagramAccount({ workspaceId: workspace.id, instagramId });
  if (!connection.allowed) throw new Error(`@${info.username} is already connected to another workspace`);

  // tokenExpiresAt stays null: system-user tokens never expire, and the
  // refresh-tokens cron only touches accounts that have an expiry.
  // Webhook delivery is the per-account toggle in the Meta app dashboard.
  const data = {
    username: info.username,
    name: info.name,
    accessToken: encryptToken(token),
    tokenExpiresAt: null,
    webhookSubscribed: true,
  };
  await prisma.instagramAccount.upsert({
    where: { instagramId },
    update: data,
    create: { ...data, workspaceId: workspace.id, instagramId, provider: "META" },
  });

  console.log(`Connected @${info.username} (${instagramId}) to workspace "${workspace.name}"`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
