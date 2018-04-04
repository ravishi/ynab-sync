import fs from 'fs';
import sh from 'shorthash';
import tmp from 'tmp';
import util from 'util';
import pTry from 'p-try';
import yargs from 'yargs';
import puppeteer from 'puppeteer';

const baseUrl = 'https://app.youneedabudget.com';

const onlyCommand = {
    command: '$0',

    builder: yargs => yargs
        .option('username', {
            type: 'string',
            alias: 'u',
            description: 'Username',
            demandOption: true,
        })
        .option('password', {
            type: 'string',
            alias: 'p',
            description: 'Password',
            demandOption: true,
        })
        .option('account', {
            type: 'string',
            alias: 'a',
            description: 'Account you want to sync into',
            demandOption: true,
        })
        .option('input', {
            type: 'string',
            alias: 'i',
            normalize: true,
            description: 'Input file',
            demandOption: true,
        })
        .option('extra', {
            type: 'string',
            array: true,
            alias: 'x',
            default: [],
            description: 'Extra, undocumented options',
            demandOption: false,
        }),

    handler: (argv) => {
        return pTry(() => main(argv))
            .then(exitCode => process.exit(exitCode || 0), err => {
                console.error(err);
                process.exit(1);
            });
    }
};

void yargs.command(onlyCommand)
    .help()
    .version()
    .argv;

async function main(options) {
    const {
        extra,
        input: inputPath,
        account: accountName,
        username,
        password,
    } = options;

    const headless = !extra.includes('headful');

    const asyncReadFile = util.promisify(fs.readFile);

    const input = JSON.parse(await asyncReadFile(inputPath));

    const browser = await puppeteer.launch({headless});
    try {
        const page = await browser.newPage();

        await page.setBypassCSP(true);

        const responses = [];
        const responseCollector = async (response) => {
            const json = await response.json().catch(() => undefined);
            if (json !== undefined) {
                responses.push(json);
            }
        };

        page.on('response', responseCollector);

        try {
            await loggedInGoTo(page, baseUrl, {username, password});

            const accountBtn = await page.waitForSelector(
                `.nav-account-name[title="${accountName}"]`
            );

            await Promise.all([
                accountBtn.click(),
                waitForNetworkIdle(page, {timeout: 1000})
            ]);
        } finally {
            page.removeListener('response', responseCollector);
        }

        const {changed, missing} = await calcDiff({input, responses, accountName});

        if (changed.length || missing.length) {
            console.log(
                `Identified ${missing.length} new transactions `
                + `and ${changed.length} changed with different dates`
            );

            for (let i = 0; i < changed.length; i++) {
                console.log(`Changing dates: ${i+1} of ${changed.length}...`);
                await executeFixChanged(page, changed[i], {username, password});
            }

            if (missing.length) {
                console.log('Importing transactions...');
                await executeImportTransactions(page, missing);
            }
        } else {
            console.log('No new transactions found');
        }
    } finally {
        await browser.close();
    }

    console.log('Done!');

    return 0;
}

const asyncFsUnlink = util.promisify(fs.unlink);

async function executeImportTransactions(page, transactions) {
    const ofxFilePath = await generateOfxFile(transactions);
    try {
        const importButton = await page.waitForSelector('.accounts-toolbar-file-import-transactions');

        await importButton.click();

        const fileInput = await page.waitForSelector('input[type="file"]');

        await fileInput.uploadFile(ofxFilePath);

        const confirmBtn = await page.waitForSelector('.modal-import-review button.button-primary');

        return Promise.all([
            confirmBtn.click(),
            waitForNetworkIdle(page),
        ]);
    } finally {
        try {
            await asyncFsUnlink(ofxFilePath);
        } catch (err) {
            console.warn('Failed to remove temporary file', err);
        }
    }
}

async function setInputValueAndBubbleChange(page, selector, value) {
    return await page.evaluate((selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('change', {bubbles: true}));
    }, selector, value);
}

async function generateOfxFile(transactions) {
    const filePath = await temporaryFileName({template: '/tmp/ynab-sync-XXXXXXXX.ofx'});

    const data = generateOfx(transactions, true);

    await writeToFile(data, filePath);

    return filePath;
}

async function temporaryFileName(options) {
    return await new Promise((resolve, reject) => {
        tmp.tmpName(options, (err, path) => {
            if (err) {
                reject(err);
            } else {
                resolve(path);
            }
        });
    });
}

async function calcDiff({accountName, input, responses}) {
    const accounts = responses
        .find(r => r.changed_entities && r.changed_entities.be_accounts)
        .changed_entities.be_accounts;

    const account = accounts.find(i => i.account_name === accountName);

    input = input.map(({id, date, amount, ...rest}) => {
            return {
                id,
                date: date.date,
                amount,
                shortId: sh.unique(id),
                compareAmount: (() => {
                    const value = parseInt(amount.replace(/^-/, '').replace(/\./, '')) * 10;
                    return (amount.startsWith('-') ? 1 : -1) * value;
                })(),
                ...rest,
            };
        });

    const transactions = responses
        .find(r => r.changed_entities && r.changed_entities.be_transactions)
        .changed_entities.be_transactions
        .filter(t => t.entities_account_id === account.id);

    const different = input
        .filter(i => i.date.startsWith('2018') || i.date.startsWith('2017'))
        .filter(i => undefined === transactions.find(t => i.date === t.date && i.compareAmount === t.amount))
        .map(i => {
            i.original = transactions.find(t => (
                t.memo && (
                    t.memo.includes('#' + i.shortId)
                    /*|| (
                        t.memo === i.title && t.amount === i.compareAmount
                    )*/
                )
            ));
            return i;
        });

    const changed = different.filter(i => i.original);
    const missing = different.filter(i => !i.original);

    const s = JSON.stringify({input, transactions, different, changed, missing}, null, 2);
    const tempFile = await temporaryFileName();
    await writeToFile(s, tempFile);

    return {changed, missing};
}

async function executeFixChanged(page, changed) {
    const searchInput = await page.waitForSelector('.transaction-search-input');

    await searchInput.type(`Memo:#${changed.shortId}${String.fromCharCode(13)}`, {wait: 58});

    const dateCell = await page.waitForSelector(
        `[data-row-id="${changed.original.id}"] .ynab-grid-cell-date`
    );

    await dateCell.click();
    await dateCell.focus();

    const selectorForCell = '.is-checked .ynab-grid-cell-date';
    await page.evaluate(`$('${selectorForCell}').click();`);

    await new Promise(resolve => setTimeout(resolve, 1000));

    await page.evaluate(`$('${selectorForCell}').click();`);

    const selectorForDateInput = `${selectorForCell} input`;

    const dateInput = await page.waitForSelector(selectorForDateInput);

    const date = changed.date.split('-').reverse().join('/');

    await setInputValueAndBubbleChange(page, selectorForDateInput, '');

    await dateInput.type(date, {wait: 58});

    const saveBtn = await page.waitForSelector('.ynab-grid-actions-buttons .button-primary');

    return Promise.all([
        saveBtn.click(),
        waitForNetworkIdle(page, {timeout: 1000}),
    ]);
}

async function loggedInGoTo(page, url, {username, password, ...options} = {}) {
    if (options.waitFor) {
        console.warn('loggedInGoTo will ignore options.waitFor');
    }
    const gotoOptions = {...options, waitFor: 'networkidle0'};
    const r1 = await page.goto(url, gotoOptions);
    const currentUrl = await page.evaluate('location.href');
    if (!currentUrl.endsWith('/users/login')) {
        return r1;
    }
    await executeLogin(page, {username, password});
    return await page.goto(url, gotoOptions);
}

async function executeLogin(page, {username, password}) {
    const emailInput = await page.waitForSelector(
        '.users-form input[placeholder="email address"]', {visible: true});
    await emailInput.focus();
    await emailInput.type(username, {delay: 58});

    const passwordInput = await page.waitForSelector(
        '.users-form input[placeholder="password"]', {visible: true});
    await passwordInput.focus();
    await passwordInput.type(password, {delay: 58});

    const loginButton = await page.waitForSelector('.users-form button.button-primary');

    await Promise.all([
        loginButton.click(),
        waitForNetworkIdle(page, {timeout: 1000}),
    ]);

    const selectorForProfileButton = '.button-prefs-user .button-truncate';
    await page.waitForSelector(selectorForProfileButton);
    const loggedInUsername = await page.evaluate(
        (selector) => document.querySelector(selector).textContent,
        selectorForProfileButton
    );
    return username === loggedInUsername;
}

async function waitForNetworkIdle(page, {timeout = 500, requests = 0, globalTimeout = null} = {}) {
    return await new Promise((resolve, reject) => {
        const deferred = [];
        const cleanup = () => deferred.reverse().forEach(fn => fn());
        const cleanupAndReject = (err) => cleanup() || reject(err);
        const cleanupAndResolve = (val) => cleanup() || resolve(val);

        if (globalTimeout === null) {
            globalTimeout = page._defaultNavigationTimeout;
        }

        const globalTimeoutId = setTimeout(
            cleanupAndReject,
            globalTimeout,
            new Error('Waiting for network idle timed out')
        );

        deferred.push(() => {
            clearTimeout(globalTimeoutId);
        });

        let inFlight = 0;
        let timeoutId = setTimeout(cleanupAndResolve, timeout);

        deferred.push(() => clearTimeout(timeoutId));

        const onRequest = () => {
            ++inFlight;
            if (inFlight > requests) {
                clearTimeout(timeoutId);
            }
        };

        const onResponse = () => {
            if (inFlight === 0) {
                return;
            }
            --inFlight;
            if (inFlight <= requests) {
                timeoutId = setTimeout(cleanupAndResolve, timeout);
            }
        };

        page.on('request', onRequest);
        page.on('requestfailed', onResponse);
        page.on('requestfinished', onResponse);

        deferred.push(() => {
            page.removeListener('request', onRequest);
            page.removeListener('requestfailed', onResponse);
            page.removeListener('requestfinished', onResponse);
        });
    });
}

async function writeToFile(s, path) {
    return await new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function ofxItem(itemData, detailed) {
    const {
        id,
        date,
        title,
        amount,
    } = itemData;
    const shortid = sh.unique(id);
    const memo = (
        detailed ? `#${shortid} - ${title}` : title
    );
    return `
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${date.replace(/-/g, '')}000000[-3:GMT]
<TRNAMT>${amount * -1}
<FITID>${id}</FITID>
<MEMO>${memo}</MEMO>
</STMTTRN>
`;
}

function generateOfx(charges, detailed) {
    return `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>

<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<CCSTMTRS>
<CURDEF>BRL
<CCACCTFROM>
<ACCTID>nubank-ofx-preview
</CCACCTFROM>

<BANKTRANLIST>
${charges.map(i => ofxItem(i, detailed)).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
