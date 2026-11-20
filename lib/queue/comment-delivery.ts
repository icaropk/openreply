import { prisma } from "@/lib/db/client";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
): Promise<boolean> {
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      ...(leg === "dm"
        ? {
            status: { not: "SENT" as const },
            dmDeliveryUnconfirmed: false,
            attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
          }
        : { publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false }),
    },
    data:
      leg === "dm"
        ? {
            dmDeliveryUnconfirmed: true,
            attempts: { increment: 1 },
            status: "PENDING",
            errorMessage: null,
          }
        : { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}

/**
 * Give back the attempt a send spent when Meta refused it for the app-wide
 * quota (code 4): the refusal says nothing about this comment, and the job is
 * put back in the queue to run again once the meter has room.
 */
export async function refundQuotaAttempt(commentId: string): Promise<void> {
  await prisma.dmLog.updateMany({
    where: { commentId, attempts: { gt: 0 }, errorMessage: { contains: "(#4)" } },
    data: { attempts: { decrement: 1 } },
  });
}
