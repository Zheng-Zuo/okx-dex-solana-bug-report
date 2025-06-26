### [S-Critial-Part1] Pump.fun Integration Failure Due to Outdated Account Structure

**Description**

The DEX Solana protocol's Pump.fun integration adapter (programs/dex-solana/src/adapters/pumpfun.rs) contains outdated account structures that are incompatible with Pump.fun's current protocol implementation. Specifically, Pump.fun introduced a creator fee mechanism recently that requires a creator_vault account to collect a 0.05% creator fee from trades, replacing the previously used rent account in buy operations and associated_token_program account in sell operations.
The current implementation fails to accommodate this protocol change, resulting in two distinct failure modes:

-   Seeds Constraint Violation: When using the old account structure with rent account, Pump.fun expects the creator_vault account at that position, causing a seeds constraint violation (Error Code: 2006)
-   Mutability Constraint Violation: When substituting the correct creator_vault account, the account is marked as read-only in the CPI call, but Pump.fun expects it to be mutable to receive creator fees (Error Code: 2000)

**Impact**

This vulnerability renders the entire Pump.fun integration completely non-functional, preventing users from:

-   Executing buy orders through the DEX aggregator for Pump.fun tokens
-   Executing sell orders through the DEX aggregator for Pump.fun tokens

**Proof of Concepts**

```javascript
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
    SYSVAR_RENT_PUBKEY,
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
        dexSolanaProgram = new Program() < DexSolana > (IDL, provider);
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

            const createKeys = (rentOrCreatorVault: PublicKey) => [
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
                { pubkey: rentOrCreatorVault, isWritable: true, isSigner: false },
                { pubkey: eventAuthority, isWritable: false, isSigner: false },
            ];

            const keysWithRent = createKeys(SYSVAR_RENT_PUBKEY);

            // 5. Create the swap instruction
            let buyTx = await dexSolanaProgram.methods
                .swap2(swapArgs, new BN(0))
                .accounts({
                    payer: payer.publicKey,
                    sourceTokenAccount,
                    destinationTokenAccount: payerAta,
                    sourceMint: NATIVE_MINT,
                    destinationMint: tokenMint,
                })
                .remainingAccounts(keysWithRent)
                .instruction();

            // All instructions in order
            let instructions = [createAccountIx, transferIx, initAccountIx, syncNativeIx, buyTx];

            // Execute the versioned transaction
            console.log("Executing pump.fun buy swap with rent account...");
            let txResult = await createAndProcessVersionedTransaction(client, payer, instructions);

            // the transaction should fail with the custom error: 0x7d6
            console.log("\n transaction should fail with the custom error: 0x7d6 \n");
            expect(txResult.result).to.not.be.null;
            let errorString = txResult.result.toString();
            expect(errorString).to.include("custom program error: 0x7d6");

            const keysWithCreatorVault = createKeys(creatorVault);
            buyTx = await dexSolanaProgram.methods
                .swap2(swapArgs, new BN(0))
                .accounts({
                    payer: payer.publicKey,
                    sourceTokenAccount,
                    destinationTokenAccount: payerAta,
                    sourceMint: NATIVE_MINT,
                    destinationMint: tokenMint,
                })
                .remainingAccounts(keysWithCreatorVault)
                .instruction();
            instructions = [createAccountIx, transferIx, initAccountIx, syncNativeIx, buyTx];

            console.log("Executing pump.fun buy swap with creator vault account...");
            txResult = await createAndProcessVersionedTransaction(client, payer, instructions);

            // the transaction should fail with the custom error: 0x7d0, Error Message: A mut constraint was violated.
            console.log("\n transaction should fail with the custom error: 0x7d0 \n");
            expect(txResult.result).to.not.be.null;
            errorString = txResult.result.toString();
            expect(errorString).to.include("custom program error: 0x7d0");
        });
    });
});

// this error
// Program log: AnchorError caused by account: creator_vault. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.
// Program log: Left:
// Program log: SysvarRent111111111111111111111111111111111
// Program log: Right:
// Program log: BxE6X4JgY2xN8arBYBCMmagMfXSbQSEWFRFufExJwvE3

// or this error
// Program log: AnchorError caused by account: creator_vault. Error Code: ConstraintMut. Error Number: 2000. Error Message: A mut constraint was violated.
```

**Recommended mitigation**

in file: `programs/dex-solana/src/adapters/pumpfun.rs`, make the following changes:

```rust
@@ -75,7 +75,7 @@ pub struct PumpfunBuyAccounts<'info> {
     pub associated_bonding_curve: &'info AccountInfo<'info>,
     pub system_program: Program<'info, System>,
     pub token_program: Program<'info, Token>,
-    pub rent: &'info AccountInfo<'info>,
+    pub creator_vault: &'info AccountInfo<'info>,
     pub event_authority: &'info AccountInfo<'info>,
 }

@@ -117,7 +117,7 @@ impl<'info> PumpfunBuyAccounts<'info> {
             associated_bonding_curve,
             system_program,
             token_program,
-            rent,
+            creator_vault,
             event_authority,

         ]: &[AccountInfo<'info>; BUY_ACCOUNTS_LEN] = array_ref![accounts, offset, BUY_ACCOUNTS_LEN];
@@ -134,7 +134,7 @@ impl<'info> PumpfunBuyAccounts<'info> {
             associated_bonding_curve,
             system_program: Program::try_from(system_program)?,
             token_program: Program::try_from(token_program)?,
-            rent,
+            creator_vault,
             event_authority,
         })
     }
@@ -203,7 +203,7 @@ pub fn buy<'a>(
         AccountMeta::new(swap_accounts.swap_authority_pubkey.key(), true),
         AccountMeta::new_readonly(swap_accounts.system_program.key(), false),
         AccountMeta::new_readonly(swap_accounts.token_program.key(), false),
-        AccountMeta::new_readonly(swap_accounts.rent.key(), false),
+        AccountMeta::new(swap_accounts.creator_vault.key(), false),
         AccountMeta::new_readonly(swap_accounts.event_authority.key(), false),
         AccountMeta::new_readonly(swap_accounts.dex_program_id.key(), false)
     ];
@@ -218,7 +218,7 @@ pub fn buy<'a>(
         swap_accounts.swap_authority_pubkey.to_account_info(),
         swap_accounts.system_program.to_account_info(),
         swap_accounts.token_program.to_account_info(),
-        swap_accounts.rent.to_account_info(),
+        swap_accounts.creator_vault.to_account_info(),
         swap_accounts.event_authority.to_account_info(),
         swap_accounts.dex_program_id.to_account_info(),
         swap_accounts.swap_source_token.to_account_info(),
@@ -291,7 +291,7 @@ pub struct PumpfunSellAccounts<'info> {
     pub bonding_curve: &'info AccountInfo<'info>,
     pub associated_bonding_curve: &'info AccountInfo<'info>,
     pub system_program: Program<'info, System>,
-    pub associated_token_program: Program<'info, AssociatedToken>,
+    pub creator_vault: &'info AccountInfo<'info>,
     pub token_program: Program<'info, Token>,
     pub event_authority: &'info AccountInfo<'info>,

@@ -312,7 +312,7 @@ impl<'info> PumpfunSellAccounts<'info> {
             bonding_curve,
             associated_bonding_curve,
             system_program,
-            associated_token_program,
+            creator_vault,
             token_program,
             event_authority,

@@ -329,7 +329,7 @@ impl<'info> PumpfunSellAccounts<'info> {
             bonding_curve,
             associated_bonding_curve,
             system_program: Program::try_from(system_program)?,
-            associated_token_program: Program::try_from(associated_token_program)?,
+            creator_vault,
             token_program: Program::try_from(token_program)?,
             event_authority,

@@ -399,7 +399,7 @@ pub fn sell<'a>(
         AccountMeta::new(swap_accounts.swap_source_token.key(), false),
         AccountMeta::new(swap_accounts.swap_authority_pubkey.key(), true),
         AccountMeta::new_readonly(swap_accounts.system_program.key(), false),
-        AccountMeta::new_readonly(swap_accounts.associated_token_program.key(), false),
+        AccountMeta::new(swap_accounts.creator_vault.key(), false),
         AccountMeta::new_readonly(swap_accounts.token_program.key(), false),
         AccountMeta::new_readonly(swap_accounts.event_authority.key(), false),
         AccountMeta::new_readonly(swap_accounts.dex_program_id.key(), false),
@@ -414,7 +414,7 @@ pub fn sell<'a>(
         swap_accounts.swap_source_token.to_account_info(),
         swap_accounts.swap_authority_pubkey.to_account_info(),
         swap_accounts.system_program.to_account_info(),
-        swap_accounts.associated_token_program.to_account_info(),
+        swap_accounts.creator_vault.to_account_info(),
         swap_accounts.token_program.to_account_info(),
         swap_accounts.event_authority.to_account_info(),
         swap_accounts.dex_program_id.to_account_info(),
```
