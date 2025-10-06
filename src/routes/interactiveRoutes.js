import { prismaQuery } from "../lib/prisma.js";

/**
 * Interactive Routes
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */


export const interactiveRoutes = (app, _, done) => {
  // Simulation counter stored in memory
  let simulateCounter = 0;

  app.get("/pivy-activity", async (request, reply) => {
    try {
      const pivyUser = await prismaQuery.user.findFirst({
        where: {
          username: "pivy"
        }
      })

      if (!pivyUser) {
        return reply.code(404).send({
          message: "Pivy user not found",
          data: null,
        });
      }

      const payments = await prismaQuery.payment.findMany({
        where: {
          link: {
            userId: pivyUser.id,
            label: "personal",
            tag: ""
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 20,
        select: {
          payerUser: {
            select: {
              username: true,
              profileImageData: true,
              profileImageType: true,
            }
          },
          amount: true,
          mint: {
            select: {
              decimals: true,
              symbol: true,
              imageUrl: true,
            }
          },
          paymentInfo: {
            select: {
              collectedData: true,
            }
          },
          timestamp: true,
          id: true,
        }
      })

      console.log("Pivy payments:", payments.length);

      // Transform payments to handle BigInt serialization
      const transformedPayments = payments
        .map(payment => {
          // Extract note from paymentInfo if it exists
          const note = payment.paymentInfo?.collectedData?.find(item => item.type === 'note')?.value || "---";

          return {
            id: payment.id,
            payerUser: payment.payerUser,
            amount: payment.amount.toString(),
            uiAmount: Number(payment.amount) / Math.pow(10, payment.mint.decimals),
            note: note,
            timestamp: payment.timestamp,
            tokenInfo: {
              symbol: payment.mint.symbol,
              imageUrl: payment.mint.imageUrl,
            }
          };
        });

      // Check for simulation mode
      const isSimulate = request.query.simulate === 'true';

      if (isSimulate && transformedPayments.length > 0) {
        // Increment counter (1-based indexing)
        simulateCounter = (simulateCounter % transformedPayments.length) + 1;
        
        // Return only the payments up to the current counter
        const simulatedPayments = transformedPayments.slice(0, simulateCounter);
        
        return reply.code(200).send(simulatedPayments);
      }

      return reply.code(200).send(transformedPayments);
    } catch (error) {
      console.error("Error getting pivy payments:", error);
      return reply.code(500).send({
        message: error.message,
        data: null,
      });
    }
  })

  done();
}