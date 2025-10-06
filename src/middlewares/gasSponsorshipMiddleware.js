import { formatUnits } from "ethers";
import { GAS_SPONSORSHIP } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { handleError } from "../utils/errorHandler.js";

export const gasSponsorshipMiddleware = async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
        return handleError(reply, 401, "Unauthorized");
    }

    const { chain } = request.body;
    if (!chain || typeof chain !== 'string') {
        return;
    }

    if (chain.startsWith("APTOS")) {
        const aptosSponsorship = GAS_SPONSORSHIP.APTOS;
        if (!aptosSponsorship.ONE_DAY_HARD_LIMIT) {
            return;
        }

        const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

        const result = await prismaQuery.gasSponsorshipLog.aggregate({
            _sum: {
                gasFee: true,
            },
            where: {
                userId: userId,
                chain: {
                    in: ["APTOS_MAINNET", "APTOS_TESTNET"],
                },
                timestamp: {
                    gte: oneDayAgo,
                },
            },
        });

        const totalGasUsed = result._sum.gasFee || 0n;

        if (totalGasUsed >= aptosSponsorship.ONE_DAY_HARD_LIMIT) {
            const limit = aptosSponsorship.ONE_DAY_HARD_LIMIT;
            const usageFormatted = formatUnits(totalGasUsed, 8); // APT uses 8 decimals
            const limitFormatted = formatUnits(limit, 8);

            const message = `Daily gas sponsorship limit exceeded. Used: ${usageFormatted} APT / ${limitFormatted} APT.`;

            return handleError(reply, 403, message, "SPONSORSHIP_LIMIT_EXCEEDED", {
                usage: totalGasUsed.toString(),
                limit: limit.toString(),
            });
        }
    }
};
