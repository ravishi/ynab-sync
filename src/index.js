import fs from 'fs';
import sh from 'shorthash';
import util from 'util';
import pTry from 'p-try';
import yargs from 'yargs';
import * as ynab from 'ynab';

const onlyCommand = {
    command: '$0',

    builder: yargs => yargs
        .option('token', {
            type: 'string',
            alias: 't',
            description: 'Personal access token',
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
        token,
        account: accountName,
    } = options;

    const asyncReadFile = util.promisify(fs.readFile);

    const input = JSON.parse(await asyncReadFile(inputPath));

    const ynabApi = new ynab.API(token);

    const budget = (await ynabApi.budgets.getBudgets()).data.budgets[0];

    const accounts = (await ynabApi.accounts.getAccounts(budget.id)).data.accounts;

    const account = (accounts.filter(i => i.name === accountName) || [{}])[0];

    if (!account.id) {
        const accountNames = accounts.map(i => i.name);
        throw new Error(`Account '${accountName} not found in ${accountNames.join(', ')}`);
    }

    const transactions = (
        await ynabApi.transactions
            .getTransactionsByAccount(budget.id, account.id)
    ).data.transactions;

    const {changed, missing} = await calcDiff({input, transactions});


    if (!(changed.length || missing.length)) {
        console.log('No new transactions found');
        return 0;
    }

    console.log(
        `Identified ${missing.length} new transactions `
        + `and ${changed.length} changed with different dates`
    );

    const updated = changed.map(({original, date}) => ({
        ...original,
        date,
    }));

    const toBeCreated = missing.map(({id, title, date, shortId, compareAmount}) => ({
        date,
        memo: `#${shortId} ${title}`,
        amount: compareAmount,
        import_id: id,
        account_id: account.id,
    }));

    updated.forEach(async (transaction, i) => {
        console.log(`Changing dates: ${i+1} of ${changed.length}...`);
        await ynabApi.transactions.updateTransaction(budget.id, transaction.id, {transaction});
    });

    console.log('Importing transactions...');
    await ynabApi.transactions.bulkCreateTransactions(budget.id, {transactions: toBeCreated});

    console.log('Done!');

    return 0;
}

async function calcDiff({input, transactions}) {
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

    const different = input
        .filter(i => i.date.startsWith('2018') || i.date.startsWith('2017'))
        .filter(i => undefined === transactions.find(t => i.date === t.date && i.compareAmount === t.amount))
        .map(i => {
            i.original = transactions.find(t => (
                t.memo && t.memo.includes('#' + i.shortId)
            ));
            return i;
        });

    const changed = different.filter(i => i.original);
    const missing = different.filter(i => !i.original);

    return {changed, missing};
}
