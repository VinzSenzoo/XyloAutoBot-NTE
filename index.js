import blessed from "blessed";
import figlet from "figlet";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as ethers from "ethers";
import axios from "axios";

const CONFIG_FILE = "config.json";
const isDebug = false;

const RPC_URL = "https://rpc.testnet.arc.network/";
const CHAIN_ID = 5042002;
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ROUTER_ADDRESS = "0x73742278c31a76dBb0D2587d03ef92E6E2141023";
const DECIMALS = 6;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const ROUTER_ABI = [
  "function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function swap((address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline)) returns (uint256)"
];

const FAUCET_API_URL = "https://faucet.circle.com/api/graphql";
const CAPTCHA_SITE_KEY = "6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve";
const CAPTCHA_PAGE_URL = "https://faucet.circle.com/";
const TWO_CAPTCHA_IN_URL = "https://2captcha.com/in.php";
const TWO_CAPTCHA_RES_URL = "https://2captcha.com/res.php";

let twoCaptchaApiKey = "";

let walletInfo = {
  address: "N/A",
  balanceUSDC: "0.00",
  balanceEURC: "0.00",
  activeAccount: "N/A",
  cycleCount: 0,
  nextCycle: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let addresses = [];
let privateKeys = [];
let wallets = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  swapRepetitions: 1,
  minUsdcAmount: 0.01,
  maxUsdcAmount: 0.05,
  minEurcAmount: 0.009,
  maxEurcAmount: 0.049,
  twoCaptchaApiKey: ""
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.swapRepetitions = Number(config.swapRepetitions) || 1;
      dailyActivityConfig.minUsdcAmount = Number(config.minUsdcAmount) || 0.01;
      dailyActivityConfig.maxUsdcAmount = Number(config.maxUsdcAmount) || 0.05;
      dailyActivityConfig.minEurcAmount = Number(config.minEurcAmount) || 0.009;
      dailyActivityConfig.maxEurcAmount = Number(config.maxEurcAmount) || 0.049;
      dailyActivityConfig.twoCaptchaApiKey = config.twoCaptchaApiKey || "";
      twoCaptchaApiKey = dailyActivityConfig.twoCaptchaApiKey;
      addLog(`Loaded Config Successfully`, "success");
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}, using default settings.`, "error");
  }
}

function saveConfig() {
  dailyActivityConfig.twoCaptchaApiKey = twoCaptchaApiKey;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = `{red-fg}${message}{/red-fg}`;
      break;
    case "success":
      coloredMessage = `{green-fg}${message}{/green-fg}`;
      break;
    case "wait":
      coloredMessage = `{yellow-fg}${message}{/yellow-fg}`;
      break;
    case "proses":
      coloredMessage = `{cyan-fg}${message}{/cyan-fg}`;
      break;
    case "debug":
      coloredMessage = `{blue-fg}${message}{/blue-fg}`;
      break;
    default:
      coloredMessage = message;
  }
  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  addLog("Transaction logs cleared.", "success");
  updateLogs();
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process stopped successfully.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(pk => pk.trim()).filter(pk => pk.match(/^(0x)?[0-9a-fA-F]{64}$/));
    privateKeys = privateKeys.map(pk => pk.startsWith('0x') ? pk : '0x' + pk);
    wallets = privateKeys.map(pk => new ethers.Wallet(pk));
    addresses = wallets.map(w => w.address);
    if (addresses.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${addresses.length} wallets from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
    wallets = [];
    addresses = [];
  }
}

function loadProxies() {
  try {
    const data = fs.readFileSync("proxy.txt", "utf8");
    proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
    if (proxies.length === 0) throw new Error("No proxies found in proxy.txt");
    addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
  } catch (error) {
    addLog(`No proxy.txt found or failed to load, running without proxies: ${error.message}`, "warn");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProvider(proxyUrl = null) {
  const options = {};
  if (proxyUrl) {
    const agent = createAgent(proxyUrl);
    options.fetchOptions = { agent };
  }
  return new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, options);
}

async function updateWalletData() {
  const walletDataPromises = addresses.map(async (address, i) => {
    const proxyUrl = proxies[i % proxies.length] || null;
    const provider = getProvider(proxyUrl);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const eurcContract = new ethers.Contract(EURC_ADDRESS, ERC20_ABI, provider);
    try {
      const usdcBalance = await usdcContract.balanceOf(address);
      const eurcBalance = await eurcContract.balanceOf(address);
      const formattedUSDC = (Number(usdcBalance) / 10 ** DECIMALS).toFixed(4);
      const formattedEURC = (Number(eurcBalance) / 10 ** DECIMALS).toFixed(4);
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${getShortAddress(address)}   ${formattedUSDC.padEnd(8)}  ${formattedEURC.padEnd(8)}`;
      if (i === selectedWalletIndex) {
        walletInfo.address = address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceUSDC = formattedUSDC;
        walletInfo.balanceEURC = formattedEURC;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.00 0.00`;
    }
  });
  const walletData = await Promise.all(walletDataPromises);
  addLog("Wallet data updated.", "info");
  return walletData;
}

async function solveCaptcha() {
  if (!twoCaptchaApiKey) {
    return null;
  }
  try {
    addLog("Solving captcha...", "info");
    const submitResponse = await axios.post(TWO_CAPTCHA_IN_URL, null, {
      params: {
        key: twoCaptchaApiKey,
        method: 'userrecaptcha',
        googlekey: CAPTCHA_SITE_KEY,
        pageurl: CAPTCHA_PAGE_URL,
        json: 1
      }
    });
    if (submitResponse.data.status !== 1) {
      throw new Error("Captcha submission failed: " + submitResponse.data.request);
    }
    const captchaId = submitResponse.data.request;

    let token = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(5000);
      const resResponse = await axios.get(TWO_CAPTCHA_RES_URL, {
        params: {
          key: twoCaptchaApiKey,
          action: 'get',
          id: captchaId,
          json: 1
        }
      });
      if (resResponse.data.status === 1) {
        token = resResponse.data.request;
        break;
      } else if (resResponse.data.request !== 'CAPCHA_NOT_READY') {
        throw new Error("Captcha retrieval failed: " + resResponse.data.request);
      }
    }
    if (!token) {
      throw new Error("Captcha solve timeout");
    }
    addLog("Captcha solved successfully.", "success");
    return token;
  } catch (error) {
    addLog(`Captcha solve failed: ${error.message}`, "error");
    return null;
  }
}

async function claimFaucet(address, tokenType) {
  addLog(`Starting claiming faucet  ${tokenType}`, "proses");
  const token = await solveCaptcha();
  if (!token) {
    addLog(`Skipping Claiming Faucet ${tokenType} . 2Captcha API Invalid or Doesnt Exist .`, "warn");
    return false;
  }

  const payload = {
    operationName: "RequestToken",
    variables: {
      input: {
        destinationAddress: address,
        token: tokenType,
        blockchain: "ARC"
      }
    },
    query: "mutation RequestToken($input: RequestTokenInput!) {\n requestToken(input: $input) {\n ...RequestTokenResponseInfo\n __typename\n }\n}\n\nfragment RequestTokenResponseInfo on RequestTokenResponse {\n amount\n blockchain\n contractAddress\n currency\n destinationAddress\n explorerLink\n hash\n status\n __typename\n}"
  };

  const headers = {
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9,id;q=0.8",
    "apollo-require-preflight": "true",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "origin": "https://faucet.circle.com",
    "pragma": "no-cache",
    "priority": "u=1, i",
    "recaptcha-action": "request_token",
    "recaptcha-v2-token": token,
    "referer": "https://faucet.circle.com/",
    "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
  };

  try {
    const response = await axios.post(FAUCET_API_URL, payload, { headers });
    if (response.data.data.requestToken.status === "success") {
      addLog(`Claimed Faucet ${tokenType} Successfully. Hash: ${getShortHash(response.data.data.requestToken.hash)}`, "success");
      await updateWallets();
      return true;
    } else {
      addLog(`${tokenType} faucet claim failed: ${response.data.data.requestToken.status}`, "error");
      return false;
    }
  } catch (error) {
    addLog(`${tokenType} faucet claim error: ${error.message}`, "error");
    return false;
  }
}

async function performSwap(wallet, tokenIn, tokenOut, amount, address, proxyUrl) {
  const provider = getProvider(proxyUrl);
  const signedWallet = wallet.connect(provider);
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signedWallet);
  const tokenContract = new ethers.Contract(tokenIn, ERC20_ABI, signedWallet);

  const fixedAmount = Number(amount.toFixed(4));
  const amountIn = ethers.parseUnits(fixedAmount.toString(), DECIMALS);
  const allowance = await tokenContract.allowance(address, ROUTER_ADDRESS);

  if (allowance < amountIn) {
    addLog(`Approving ${tokenIn === USDC_ADDRESS ? 'USDC' : 'EURC'} for router...`, "info");
    const tx = await tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256);
    await tx.wait();
    addLog(`Approved. Hash: ${getShortHash(tx.hash)}`, "success");
  }

  let amountOut;
  try {
    amountOut = await router.getAmountOut(tokenIn, tokenOut, amountIn);
  } catch (error) {
    addLog(`Failed to get amount out: ${error.message}`, "error");
    return false;
  }

  const minAmountOut = (amountOut * 99n) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const params = [
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    address,
    deadline
  ];

  addLog(`Swapping ${fixedAmount.toFixed(4)} ${tokenIn === USDC_ADDRESS ? 'USDC' : 'EURC'} ➯ ${tokenOut === USDC_ADDRESS ? 'USDC' : 'EURC'}...`, "info");

  try {
    const tx = await router.swap(params);
    const receipt = await tx.wait();
    addLog(`Swap Successfully. Hash: ${getShortHash(tx.hash)}`, "success");
    await updateWallets();
    return true;
  } catch (error) {
    addLog(`Swap failed: ${error.message}`, "error");
    return false;
  }
}

async function runDailyActivity() {
  if (addresses.length === 0) {
    addLog("No valid wallets found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Swap Rounds: ${dailyActivityConfig.swapRepetitions}`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < addresses.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}...`, "info");
      const wallet = wallets[accountIndex];
      const address = addresses[accountIndex];
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(address)}`, "info");

      addLog("Starting claim Faucet process...", "info");
      if (twoCaptchaApiKey) {
        await claimFaucet(address, "USDC");
        await sleep(Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000);
        await claimFaucet(address, "EURC");
      } else {
        addLog("Skipping faucet claim due to missing 2Captcha API Key.", "warn");
      }

      if (!shouldStop) {
        const randomDelay = Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000;
        addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before next process...`, "wait");
        await sleep(randomDelay);
      }

      addLog("Starting Auto Swap Process...", "info");

      let swapDirection = true;
      for (let i = 0; i < dailyActivityConfig.swapRepetitions && !shouldStop; i++) {
        const tokenIn = swapDirection ? USDC_ADDRESS : EURC_ADDRESS;
        const tokenOut = swapDirection ? EURC_ADDRESS : USDC_ADDRESS;
        const minAmount = swapDirection ? dailyActivityConfig.minUsdcAmount : dailyActivityConfig.minEurcAmount;
        const maxAmount = swapDirection ? dailyActivityConfig.maxUsdcAmount : dailyActivityConfig.maxEurcAmount;
        const amount = Math.random() * (maxAmount - minAmount) + minAmount;
        const success = await performSwap(wallet, tokenIn, tokenOut, amount, address, proxyUrl);
        if (!success) continue;

        if (i < dailyActivityConfig.swapRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;
          addLog(`Account ${accountIndex + 1}: Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "wait");
          await sleep(randomDelay);
        }

        swapDirection = !swapDirection;
      }

      if (accountIndex < addresses.length - 1 && !shouldStop) {
        addLog(`Waiting 60 seconds before next account...`, "wait");
        await sleep(60000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog(`Daily activity stopped successfully.`, "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "XYLO TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: " Status ",
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information ",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs ",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, scrollbar: { bg: "cyan" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: true,
  tags: true,
  mouse: true,
  keys: true,
  vi: true
});

const menuBox = blessed.list({
  label: " Main Menu ",
  top: "45%",
  left: 0,
  width: "40%",
  height: "55%",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, selected: { bg: "green" } },
  items: ["Start Auto Daily Activity", "Set Manual Config", "Set 2Captcha API Key", "Refresh Wallet Info", "Clear Logs", "Exit"],
  keys: true,
  vi: true,
  mouse: true
});

const dailyActivitySubMenu = blessed.list({
  label: " Daily Activity Config ",
  top: "45%",
  left: 0,
  width: "40%",
  height: "55%",
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" }, selected: { bg: "green" } },
  items: ["Set Swap Repetitions", "Set USDC Amount Config", "Set EURC Amount Config", "Back to Main Menu"],
  keys: true,
  vi: true,
  mouse: true,
  hidden: true
});

const repetitionsForm = blessed.form({
  label: " Enter Swap Repetitions ",
  top: "center",
  left: "center",
  width: "30%",
  height: "30%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const repetitionsInput = blessed.textbox({
  parent: repetitionsForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const repetitionsSubmitButton = blessed.button({
  parent: repetitionsForm,
  top: 5,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

const usdcAmountConfigForm = blessed.form({
  label: " Set USDC Amount Config ",
  top: "center",
  left: "center",
  width: "30%",
  height: "50%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minUsdcInput = blessed.textbox({
  parent: usdcAmountConfigForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  label: "Min USDC Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const maxUsdcInput = blessed.textbox({
  parent: usdcAmountConfigForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  label: "Max USDC Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const usdcAmountSubmitButton = blessed.button({
  parent: usdcAmountConfigForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

const eurcAmountConfigForm = blessed.form({
  label: " Set EURC Amount Config ",
  top: "center",
  left: "center",
  width: "30%",
  height: "50%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minEurcInput = blessed.textbox({
  parent: eurcAmountConfigForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  label: "Min EURC Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const maxEurcInput = blessed.textbox({
  parent: eurcAmountConfigForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  label: "Max EURC Amount",
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const eurcAmountSubmitButton = blessed.button({
  parent: eurcAmountConfigForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

const apiKeyForm = blessed.form({
  label: " Enter 2Captcha API Key ",
  top: "center",
  left: "center",
  width: "30%",
  height: "30%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const apiKeyInput = blessed.textbox({
  parent: apiKeyForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const apiKeySubmitButton = blessed.button({
  parent: apiKeyForm,
  top: 5,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green" }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(repetitionsForm);
screen.append(usdcAmountConfigForm);
screen.append(eurcAmountConfigForm);
screen.append(apiKeyForm);

if (!global.__neuraHandlersAttached) {
  global.__neuraHandlersAttached = true;

  function safeRemoveListeners(el, ev) {
    if (!el) return;
    if (typeof el.removeAllListeners === "function") {
      try { el.removeAllListeners(ev); } catch (e) {}
    } else if (typeof el.off === "function") {
      try { el.off(ev); } catch (e) {}
    }
  }

  function makeDebouncedHandler(fn, delay = 400) {
    let timer = null;
    return (...args) => {
      if (timer) return;
      try { fn(...args); } catch(e){}
      timer = setTimeout(() => { timer = null; }, delay);
    };
  }

  try {
    safeRemoveListeners(usdcAmountSubmitButton, "press");
    safeRemoveListeners(usdcAmountSubmitButton, "click");
    const handleUsdcSubmit = makeDebouncedHandler(() => {
      try { if (usdcAmountConfigForm && typeof usdcAmountConfigForm.submit === "function") usdcAmountConfigForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    usdcAmountSubmitButton.on("press", handleUsdcSubmit);
    usdcAmountSubmitButton.on("click", () => { try { screen.focusPush(usdcAmountSubmitButton); } catch(e){}; handleUsdcSubmit(); });
  } catch(e){}

  try {
    safeRemoveListeners(eurcAmountSubmitButton, "press");
    safeRemoveListeners(eurcAmountSubmitButton, "click");
    const handleEurcSubmit = makeDebouncedHandler(() => {
      try { if (eurcAmountConfigForm && typeof eurcAmountConfigForm.submit === "function") eurcAmountConfigForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    eurcAmountSubmitButton.on("press", handleEurcSubmit);
    eurcAmountSubmitButton.on("click", () => { try { screen.focusPush(eurcAmountSubmitButton); } catch(e){}; handleEurcSubmit(); });
  } catch(e){}

  try {
    safeRemoveListeners(repetitionsSubmitButton, "press");
    safeRemoveListeners(repetitionsSubmitButton, "click");
    const handleRepSubmit = makeDebouncedHandler(() => {
      try { if (repetitionsForm && typeof repetitionsForm.submit === "function") repetitionsForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    repetitionsSubmitButton.on("press", handleRepSubmit);
    repetitionsSubmitButton.on("click", () => { try { screen.focusPush(repetitionsSubmitButton); } catch(e){}; handleRepSubmit(); });
  } catch(e){}

  try {
    safeRemoveListeners(apiKeySubmitButton, "press");
    safeRemoveListeners(apiKeySubmitButton, "click");
    const handleApiKeySubmit = makeDebouncedHandler(() => {
      try { if (apiKeyForm && typeof apiKeyForm.submit === "function") apiKeyForm.submit(); } catch(e){}
      try { screen.render(); } catch(e){}
    }, 400);
    apiKeySubmitButton.on("press", handleApiKeySubmit);
    apiKeySubmitButton.on("click", () => { try { screen.focusPush(apiKeySubmitButton); } catch(e){}; handleApiKeySubmit(); });
  } catch(e){}
}

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;

  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));

  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);

  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);

  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    repetitionsForm.width = Math.floor(screenWidth * 0.3);
    repetitionsForm.height = Math.floor(screenHeight * 0.3);
    usdcAmountConfigForm.width = Math.floor(screenWidth * 0.3);
    usdcAmountConfigForm.height = Math.floor(screenHeight * 0.5);
    eurcAmountConfigForm.width = Math.floor(screenWidth * 0.3);
    eurcAmountConfigForm.height = Math.floor(screenHeight * 0.5);
    apiKeyForm.width = Math.floor(screenWidth * 0.3);
    apiKeyForm.height = Math.floor(screenHeight * 0.3);
  }

  safeRender();
}

function updateStatus() {
  const isProcessing = activityRunning || isCycleRunning;
  const status = activityRunning
    ? `${loadingSpinner[spinnerIndex]} {yellow-fg}Running{/yellow-fg}`
    : isCycleRunning
      ? `${loadingSpinner[spinnerIndex]} {yellow-fg}Waiting for next cycle{/yellow-fg}`
      : "{green-fg}Idle{/green-fg}";
  const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${addresses.length} | Swap Rounds: ${dailyActivityConfig.swapRepetitions}x | XYLO TESTNET AUTO BOT - PRO VERSION`;
  try {
    statusBox.setContent(statusText);
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
  if (isProcessing) {
    if (blinkCounter % 1 === 0) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
  }
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `{bold}{cyan-fg}     Address{/cyan-fg}{/bold}       {bold}{cyan-fg}USDC{/cyan-fg}{/bold}       {bold}{cyan-fg}EURC{/cyan-fg}{/bold}`;
  const separator = "{grey-fg}-----------------------------------------------{/grey-fg}";
  try {
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
  } catch (error) {
    addLog(`Wallet update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateLogs() {
  try {
    logBox.setContent(transactionLogs.join("\n") || "{grey-fg}Tidak ada log tersedia.{/grey-fg}");
    logBox.setScrollPerc(100);
  } catch (error) {
    addLog(`Log update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Set 2Captcha API Key", "Refresh Wallet Info", "Clear Logs", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Set 2Captcha API Key", "Refresh Wallet Info", "Clear Logs", "Exit"]
    );
  } catch (error) {
    addLog(`Menu update error: ${error.message}`, "error");
  }
  safeRender();
}

const statusInterval = setInterval(updateStatus, 100);

menuBox.on("select", async item => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
      }
      addLog("Stopping daily activity... Please wait for ongoing processes to complete.", "info");
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog(`Daily activity stopped successfully.`, "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.select(0);
          safeRender();
        }
      }, 100);
      break;
    case "Set 2Captcha API Key":
      apiKeyForm.show();
      apiKeyForm.setFront();
      setTimeout(() => {
        if (apiKeyForm.visible) {
          screen.focusPush(apiKeyInput);
          apiKeyInput.setValue(twoCaptchaApiKey);
          safeRender();
        }
      }, 100);
      break;
    case "Refresh Wallet Info":
      loadPrivateKeys();
      await updateWallets();
      addLog("Wallet information refreshed.", "success");
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
  menuBox.focus();
  safeRender();
});

dailyActivitySubMenu.on("select", item => {
  const action = item.getText();
  switch (action) {
    case "Set Swap Repetitions":
      repetitionsForm.show();
      repetitionsForm.setFront();
      repetitionsForm.configType = "swap";
      setTimeout(() => {
        if (repetitionsForm.visible) {
          screen.focusPush(repetitionsInput);
          repetitionsInput.setValue(dailyActivityConfig.swapRepetitions.toString());
          safeRender();
        }
      }, 100);
      break;
    case "Set USDC Amount Config":
      usdcAmountConfigForm.show();
      usdcAmountConfigForm.setFront();
      setTimeout(() => {
        if (usdcAmountConfigForm.visible) {
          screen.focusPush(minUsdcInput);
          minUsdcInput.setValue(dailyActivityConfig.minUsdcAmount.toString());
          maxUsdcInput.setValue(dailyActivityConfig.maxUsdcAmount.toString());
          safeRender();
        }
      }, 100);
      break;
    case "Set EURC Amount Config":
      eurcAmountConfigForm.show();
      eurcAmountConfigForm.setFront();
      setTimeout(() => {
        if (eurcAmountConfigForm.visible) {
          screen.focusPush(minEurcInput);
          minEurcInput.setValue(dailyActivityConfig.minEurcAmount.toString());
          maxEurcInput.setValue(dailyActivityConfig.maxEurcAmount.toString());
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.select(0);
          safeRender();
        }
      }, 100);
      break;
  }
});

repetitionsInput.key(["enter"], () => {
  repetitionsForm.submit();
});

repetitionsForm.on("submit", () => {
  const repetitionsText = repetitionsInput.getValue().trim();
  let repetitions;
  try {
    repetitions = parseInt(repetitionsText, 10);
    if (isNaN(repetitions) || repetitions < 1 || repetitions > 1000) {
      addLog("Invalid input. Please enter a number between 1 and 1000.", "error");
      repetitionsInput.setValue("");
      screen.focusPush(repetitionsInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    repetitionsInput.setValue("");
    screen.focusPush(repetitionsInput);
    safeRender();
    return;
  }

  if (repetitionsForm.configType === "swap") {
    dailyActivityConfig.swapRepetitions = repetitions;
    addLog(`Swap Repetitions set to ${repetitions}`, "success");
  }
  saveConfig();
  updateStatus();

  repetitionsForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

repetitionsSubmitButton.on("press", () => {
  repetitionsForm.submit();
});

repetitionsForm.key(["escape"], () => {
  repetitionsForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

minUsdcInput.key(["enter"], () => {
  screen.focusPush(maxUsdcInput);
});

maxUsdcInput.key(["enter"], () => {
  usdcAmountConfigForm.submit();
});

usdcAmountSubmitButton.on("press", () => {
  usdcAmountConfigForm.submit();
});

usdcAmountConfigForm.on("submit", () => {
  const minText = minUsdcInput.getValue().trim();
  const maxText = maxUsdcInput.getValue().trim();
  let minAmount, maxAmount;
  try {
    minAmount = parseFloat(minText);
    maxAmount = parseFloat(maxText);
    if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0 || minAmount >= maxAmount) {
      addLog("Invalid input. Min and Max must be positive numbers with Min < Max.", "error");
      minUsdcInput.setValue("");
      maxUsdcInput.setValue("");
      screen.focusPush(minUsdcInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    minUsdcInput.setValue("");
    maxUsdcInput.setValue("");
    screen.focusPush(minUsdcInput);
    safeRender();
    return;
  }

  dailyActivityConfig.minUsdcAmount = minAmount;
  dailyActivityConfig.maxUsdcAmount = maxAmount;
  addLog(`USDC Amount Config set to Min: ${minAmount}, Max: ${maxAmount}`, "success");
  saveConfig();
  updateStatus();

  usdcAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

usdcAmountConfigForm.key(["escape"], () => {
  usdcAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

minEurcInput.key(["enter"], () => {
  screen.focusPush(maxEurcInput);
});

maxEurcInput.key(["enter"], () => {
  eurcAmountConfigForm.submit();
});

eurcAmountSubmitButton.on("press", () => {
  eurcAmountConfigForm.submit();
});

eurcAmountConfigForm.on("submit", () => {
  const minText = minEurcInput.getValue().trim();
  const maxText = maxEurcInput.getValue().trim();
  let minAmount, maxAmount;
  try {
    minAmount = parseFloat(minText);
    maxAmount = parseFloat(maxText);
    if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0 || minAmount >= maxAmount) {
      addLog("Invalid input. Min and Max must be positive numbers with Min < Max.", "error");
      minEurcInput.setValue("");
      maxEurcInput.setValue("");
      screen.focusPush(minEurcInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    minEurcInput.setValue("");
    maxEurcInput.setValue("");
    screen.focusPush(minEurcInput);
    safeRender();
    return;
  }

  dailyActivityConfig.minEurcAmount = minAmount;
  dailyActivityConfig.maxEurcAmount = maxAmount;
  addLog(`EURC Amount Config set to Min: ${minAmount}, Max: ${maxAmount}`, "success");
  saveConfig();
  updateStatus();

  eurcAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

eurcAmountConfigForm.key(["escape"], () => {
  eurcAmountConfigForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.select(0);
      safeRender();
    }
  }, 100);
});

apiKeyInput.key(["enter"], () => {
  apiKeyForm.submit();
});

apiKeyForm.on("submit", () => {
  twoCaptchaApiKey = apiKeyInput.getValue().trim();
  if (twoCaptchaApiKey) {
    addLog("2Captcha API Key set successfully.", "success");
    saveConfig();
  } else {
    addLog("Invalid API Key.", "error");
  }
  apiKeyForm.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.select(0);
      safeRender();
    }
  }, 100);
});

apiKeySubmitButton.on("press", () => {
  apiKeyForm.submit();
});

apiKeyForm.key(["escape"], () => {
  apiKeyForm.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.select(0);
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.select(0);
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  loadConfig();
  loadPrivateKeys();
  loadProxies();
  updateStatus();
  updateWallets();
  updateLogs();
  safeRender();
  menuBox.focus();
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();