// Required modules
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const anchor = require("@project-serum/anchor");
const {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");
const readline = require("readline");

// Solana connection
const connection = new Connection(
  "https://api.mainnet-beta.solana.com",
  "confirmed"
);

// Nosana program and IDL
const programId = new PublicKey(
  "nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE"
);
const idl = require("./nosana_staking_idl.json");

// NOS token mint address
const nosTokenMint = new PublicKey(
  "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"
);

// Load Nosana keypair
const homeDirectory = os.homedir();
const keyFilePath = path.join(homeDirectory, ".nosana", "nosana_key.json");

let authorityKeypair;
if (fs.existsSync(keyFilePath)) {
  const secretKey = JSON.parse(fs.readFileSync(keyFilePath));
  authorityKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
} else {
  console.error("Key file not found in .nosana directory.");
  process.exit(1);
}

// Anchor provider setup
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(authorityKeypair),
  { commitment: "confirmed" }
);
anchor.setProvider(provider);

// Load the Nosana staking program
const program = new anchor.Program(idl, programId, provider);

// Derive PDA addresses
const derivePDAAddresses = async () => {
  console.log("Deriving PDA addresses...");

  const [stakingPDA, stakingBump] = await PublicKey.findProgramAddress(
    [
      Buffer.from("stake"),
      nosTokenMint.toBuffer(),
      authorityKeypair.publicKey.toBuffer(),
    ],
    programId
  );

  console.log("Derived staking PDA:", stakingPDA.toBase58());

  const stakingAccountInfo = await program.account.stakeAccount.fetch(
    stakingPDA
  );

  const expectedVaultAddress = new PublicKey(stakingAccountInfo.vault);

  console.log("Expected Vault Address:", expectedVaultAddress.toBase58());

  return {
    stakingPDA,
    expectedVaultAddress,
  };
};

// Monitor Docker logs
const dockerLogStream = () => {
  console.log("Monitoring Docker logs...");

  const dockerLogs = spawn("docker", ["logs", "-f", "nosana-node"], {
    maxBuffer: 5 * 1024 * 1024, // 5MB buffer
  });

  dockerLogs.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    lines.forEach((line) => {
      if (
        line.includes("Job finished") ||
        line.includes("QUEUED  at position") ||
        line.includes("Error") ||
        line.includes("Failed")
      ) {
        console.log(`[Docker Logs]: ${line}`); // Log relevant events

        const jobFinishedMatch = line.match(/✔ Job finished ([\w\d]+)/);
        if (jobFinishedMatch) {
          const signature = jobFinishedMatch[1];
          console.log(`Job finished with signature: ${signature}`);
          console.log("Auto staking started...");
          derivePDAAddresses().then(({ stakingPDA, expectedVaultAddress }) =>
            processTransaction(signature, stakingPDA, expectedVaultAddress)
          );
        }

        const queuePositionMatch = line.match(
          /QUEUED  at position (\d+)\/(\d+)/
        );
        if (queuePositionMatch) {
          const position = queuePositionMatch[1];
          const total = queuePositionMatch[2];
          console.log(
            `Queue position: ${position} of ${total}. Waiting for jobs...`
          );
        }
      }
    });
  });

  dockerLogs.stderr.on("data", (data) => {
    console.error(`Docker logs error: ${data}`);
  });

  dockerLogs.on("close", (code) => {
    console.log(`Docker logs process exited with code ${code}`);
  });
};

// Process transaction
const processTransaction = async (
  signature,
  stakingPDA,
  expectedVaultAddress
) => {
  console.log("Fetching transaction details...");
  const confirmedTx = await connection.getParsedConfirmedTransaction(
    signature,
    "confirmed"
  );

  if (!confirmedTx || !confirmedTx.meta) {
    console.error("Transaction not found or invalid.");
    return;
  }

  const { transaction, meta } = confirmedTx;
  const { postTokenBalances, innerInstructions } = meta;

  // Get user's token account
  const userTokenAccountAddress = await getAssociatedTokenAddress(
    nosTokenMint,
    authorityKeypair.publicKey
  );

  console.log("Wallet Address:", authorityKeypair.publicKey.toBase58());
  console.log("Token Address:", userTokenAccountAddress.toBase58());

  // Extract NOS token amount
  let tokenAmount = 0;
  for (const instruction of innerInstructions) {
    for (const inner of instruction.instructions) {
      const { parsed, program } = inner;
      if (
        program === "spl-token" &&
        parsed.info.destination === userTokenAccountAddress.toBase58()
      ) {
        tokenAmount +=
          parseFloat(parsed.info.amount) /
          Math.pow(10, postTokenBalances[0].uiTokenAmount.decimals);
      }
    }
  }

  if (tokenAmount > 0) {
    console.log(
      `Received NOS tokens: ${tokenAmount.toFixed(
        5
      )}. Proceeding with staking...`
    );

    await stakeTokens(tokenAmount, stakingPDA, expectedVaultAddress);
  } else {
    console.log("No NOS tokens received for staking.");
  }
};

// Stake tokens
const stakeTokens = async (amount, stakingPDA, expectedVaultAddress) => {
  console.log(`Staking ${amount} NOS tokens...`);

  try {
    const userTokenAccountAddress = await getAssociatedTokenAddress(
      nosTokenMint,
      authorityKeypair.publicKey
    );

    const userTokenAccount = await getAccount(
      connection,
      userTokenAccountAddress
    );

    if (userTokenAccount.amount < amount * Math.pow(10, 6)) {
      console.error("Insufficient funds in user's token account.");
      return;
    }

    const transaction = new anchor.web3.Transaction();

    const transferIx = createTransferInstruction(
      userTokenAccountAddress,
      expectedVaultAddress,
      authorityKeypair.publicKey,
      amount * Math.pow(10, 6), // Amount in smallest unit
      [],
      TOKEN_PROGRAM_ID
    );

    transaction.add(transferIx);

    const topupIx = await program.methods
      .topup(new anchor.BN(amount * Math.pow(10, 6))) // Amount in smallest unit
      .accounts({
        user: userTokenAccountAddress,
        vault: expectedVaultAddress,
        stake: stakingPDA,
        authority: authorityKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    transaction.add(topupIx);

    const txSignature = await provider.sendAndConfirm(transaction, [
      authorityKeypair,
    ], {
      commitment: "confirmed",
    });

    console.log(`Staking successful, transaction signature: ${txSignature}`);
  } catch (error) {
    console.error("Error during staking: ", error);
  }
};

// Welcome message and prompt
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Display welcome message
console.log(`
Welcome to Automated Staking for Nosana Nodes v1.0 by Luzzo33
`);

rl.question(
  "Do you understand that using this script is at your own risk? (yes/no): ",
  (answer) => {
    if (answer.toLowerCase() === "yes") {
      console.log("Thank you for accepting! Auto-staking will begin shortly...");
      console.log("Waiting for jobs... Your earned NOS tokens will be auto-staked.");
      dockerLogStream(); // Start Docker log monitoring
    } else {
      console.log("You chose not to proceed. Exiting...");
      process.exit(0);
    }
  }
);
