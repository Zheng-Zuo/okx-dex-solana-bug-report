import { setProvider, Program } from "@coral-xyz/anchor";
import { DexSolana } from "../target/types/dex_solana";
import {
    AddedAccount,
    AddedProgram,
    BanksClient,
    ProgramTestContext,
    startAnchor,
    BanksTransactionResultWithMeta,
} from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { expect } from "chai";
import {
    PublicKey,
    Keypair,
    Connection,
    clusterApiUrl,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import {
    AccountLayout,
    TOKEN_PROGRAM_ID,
    ACCOUNT_SIZE,
    getAssociatedTokenAddressSync,
    NATIVE_MINT,
    createInitializeAccountInstruction,
    createSyncNativeInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import dotenv from "dotenv";

dotenv.config();

const IDL = require("../target/idl/dex_solana.json");
const projectDirectory = "";

const pumpFunProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const tokenMint = new PublicKey("7en49n4riBnBX58wt7AhJXzEWPU1D4y2vYxjw3YZpump");
const global = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
const bondingCurve = new PublicKey("ARPciSfxEJXyRjNWuzpebAv5EAkgY2eguDfizPNV8UZx");
const associatedBondingCurve = new PublicKey("GtbgE87Lu8dT4tro5chyjYNyAt8tBvJ8Y1uRBuUX6WWL");
const creatorVault = new PublicKey("BxE6X4JgY2xN8arBYBCMmagMfXSbQSEWFRFufExJwvE3");
const eventAuthority = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

async function forkAccounts(connection: Connection, addresses: PublicKey[]): Promise<AddedAccount[]> {
    const accounts: AddedAccount[] = [];

    for (const address of addresses) {
        const accountInfo = await connection.getAccountInfo(address);
        if (accountInfo) {
            accounts.push({ address, info: accountInfo });
        } else {
            console.warn(`Account ${address.toBase58()} not found on mainnet`);
        }
    }
    return accounts;
}

async function createAndProcessVersionedTransaction(
    client: BanksClient,
    payer: Keypair,
    instructions: TransactionInstruction[],
    additionalSigners: Keypair[] = []
): Promise<BanksTransactionResultWithMeta> {
    const [latestBlockhash] = await client.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash,
        instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([payer, ...additionalSigners]);

    return await client.tryProcessTransaction(versionedTx);
}

async function setupATA(
    context: ProgramTestContext,
    tokenMint: PublicKey,
    owner: PublicKey,
    amount: number,
    isNative: boolean = false
): Promise<PublicKey> {
    const tokenAccData = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
        {
            mint: tokenMint,
            owner,
            amount: BigInt(amount),
            delegateOption: 0,
            delegate: PublicKey.default,
            delegatedAmount: BigInt(0),
            state: 1,
            isNativeOption: isNative ? 1 : 0,
            isNative: isNative ? BigInt(1) : BigInt(0),
            closeAuthorityOption: 0,
            closeAuthority: PublicKey.default,
        },
        tokenAccData
    );

    const ata = getAssociatedTokenAddressSync(tokenMint, owner, true);
    const ataAccountInfo = {
        lamports: isNative ? amount : 1_000_000_000,
        data: tokenAccData,
        owner: TOKEN_PROGRAM_ID,
        executable: false,
    };

    context.setAccount(ata, ataAccountInfo);
    return ata;
}

describe("Pumpfun Buy Tests", () => {
    let context: ProgramTestContext;
    let client: BanksClient;
    let payer: Keypair;
    let payerAta: PublicKey;
    let provider: BankrunProvider;
    let dexSolanaProgram: Program<DexSolana>;
    let connection: Connection;

    before(async () => {
        connection = new Connection(clusterApiUrl("mainnet-beta"));

        const accountsToFork = [
            tokenMint,
            global,
            protocolFeeRecipient,
            bondingCurve,
            associatedBondingCurve,
            creatorVault,
            eventAuthority,
        ];

        const forkedAccounts = await forkAccounts(connection, accountsToFork);

        const programsToFork: AddedProgram[] = [
            {
                name: "pump_fun",
                programId: pumpFunProgramId,
            },
        ];

        context = await startAnchor(projectDirectory, programsToFork, forkedAccounts);
        client = context.banksClient;
        payer = context.payer;
        provider = new BankrunProvider(context);
        setProvider(provider);
        dexSolanaProgram = new Program<DexSolana>(IDL, provider);
        payerAta = await setupATA(context, tokenMint, payer.publicKey, 0);
    });

    describe("Pumpfun swap test", () => {
        it("buy", async () => {
            const inputAmount = new BN(10000);

            // Create temp WSOL account
            const seed = Date.now().toString();
            const sourceTokenAccount = await PublicKey.createWithSeed(payer.publicKey, seed, TOKEN_PROGRAM_ID);
            const rentExemption = await connection.getMinimumBalanceForRentExemption(165);

            // 1. Create account with seed
            const createAccountIx = SystemProgram.createAccountWithSeed({
                fromPubkey: payer.publicKey,
                basePubkey: payer.publicKey,
                seed,
                newAccountPubkey: sourceTokenAccount,
                lamports: rentExemption,
                space: 165,
                programId: TOKEN_PROGRAM_ID,
            });

            // 2. Transfer SOL to the account
            const transferIx = SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: sourceTokenAccount,
                lamports: BigInt(inputAmount.toString()),
            });

            // 3. Initialize as WSOL account
            const initAccountIx = createInitializeAccountInstruction(sourceTokenAccount, NATIVE_MINT, payer.publicKey);

            // 4. Sync native
            const syncNativeIx = createSyncNativeInstruction(sourceTokenAccount);

            const minAmountOut = new BN(1);

            const swapArgs: any = {
                amountIn: inputAmount,
                expectAmountOut: minAmountOut,
                minReturn: minAmountOut,
                amounts: [inputAmount],
                routes: [
                    [
                        {
                            dexes: [{ pumpfunBuy: {} }],
                            weights: Buffer.from([100]),
                        },
                    ],
                ],
            };

            const [saAuthority] = PublicKey.findProgramAddressSync([Buffer.from("okx_sa")], dexSolanaProgram.programId);

            const keys = [
                { pubkey: pumpFunProgramId, isWritable: false, isSigner: false }, // dex program id
                { pubkey: payer.publicKey, isWritable: true, isSigner: true }, // payer
                { pubkey: sourceTokenAccount, isWritable: true, isSigner: false }, // temp wsol account
                { pubkey: payerAta, isWritable: true, isSigner: false }, // destination token account
                { pubkey: global, isWritable: true, isSigner: false }, // global account
                { pubkey: protocolFeeRecipient, isWritable: true, isSigner: false }, // fee recipient
                { pubkey: tokenMint, isWritable: false, isSigner: false }, // token mint
                { pubkey: bondingCurve, isWritable: true, isSigner: false },
                { pubkey: associatedBondingCurve, isWritable: true, isSigner: false },
                { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
                { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
                { pubkey: creatorVault, isWritable: true, isSigner: false },
                { pubkey: eventAuthority, isWritable: false, isSigner: false },
            ];

            // 5. Create the swap instruction
            const buyTx = await dexSolanaProgram.methods
                .proxySwap(swapArgs, new BN(0))
                .accounts({
                    payer: payer.publicKey,
                    sourceTokenAccount,
                    destinationTokenAccount: payerAta,
                    sourceMint: NATIVE_MINT,
                    destinationMint: tokenMint,
                    sourceTokenSa: null,
                    destinationTokenSa: null,
                    sourceTokenProgram: TOKEN_PROGRAM_ID,
                    destinationTokenProgram: TOKEN_PROGRAM_ID,
                })
                .remainingAccounts(keys)
                .instruction();

            // All instructions in order
            let instructions = [createAccountIx, transferIx, initAccountIx, syncNativeIx, buyTx];

            // Execute the versioned transaction
            console.log("Executing pump.fun buy swap ...");
            let txResult = await createAndProcessVersionedTransaction(client, payer, instructions);

            // the transaction should fail with InvalidAccountData
            console.log("\n transaction should fail with InvalidAccountData \n");
            expect(txResult.result).to.not.be.null;
            let errorString = txResult.result.toString();
            console.log(errorString);
            expect(errorString).to.include("invalid account data for instruction");
        });
    });
});

// Error processing Instruction 4: invalid account data for instruction
