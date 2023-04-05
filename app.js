const fs = require('fs');
const axios = require('axios');
const https = require('https');
const winston = require('winston');

// Configure winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'chainlink-job-retriever.log' })
    ]
});

const agent = new https.Agent({
    rejectUnauthorized: false
});
const instance = axios.create({
    httpsAgent: agent
});

let activeJobs = {};

function loadNodesFromFile(filename) {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, 'utf8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                try {
                    const nodes = JSON.parse(data);
                    resolve(nodes);
                } catch (parseErr) {
                    reject(parseErr);
                }
            }
        });
    });
}


async function retrieveJobs(chainlinkNode) {
    try {
        if (!activeJobs.hasOwnProperty(chainlinkNode.name)) {
            activeJobs[chainlinkNode.name] = [];
        }
        const login = await instance.post(chainlinkNode.url + "/sessions", { "email": chainlinkNode.username, "password": chainlinkNode.password });
        const cookie = login.headers['set-cookie'];

        const body = "{\"operationName\":\"FetchJobs\",\"variables\":{\"offset\":0,\"limit\":1000},\"query\":\"fragment JobsPayload_ResultsFields on Job {\\n id\\n name\\n externalJobID\\n createdAt\\n spec {\\n __typename\\n ... on OCRSpec {\\n contractAddress\\n keyBundleID\\n transmitterAddress\\n __typename\\n }\\n }\\n __typename\\n}\\n\\nquery FetchJobs($offset: Int, $limit: Int) {\\n jobs(offset: $offset, limit: $limit) {\\n results {\\n ...JobsPayload_ResultsFields\\n __typename\\n }\\n metadata {\\n total\\n __typename\\n }\\n __typename\\n }\\n}\\n\"}"
        const response = await instance.post(chainlinkNode.url + "/query", body, {
            withCredentials: true,
            httpsAgent: agent,
            headers: {
                Cookie: cookie
            }
        });

        const jobs = response.data.data.jobs.results;
        for (const job of jobs) {
            const cleanedName = job.name.replace(/(version.*|\| OCR.*)/gi, "").replace(/network.*/gi, "").replace(/\s*\|$/, "");
            activeJobs[chainlinkNode.name].push({ "name": cleanedName, "contract": job.spec.contractAddress, "externalJobID": job.externalJobID, "createdAt": job.createdAt, "type": job.spec.__typename, });
        }
        return activeJobs;
    } catch (error) {
        logger.error(`Error retrieving jobs for ${chainlinkNode.name}: ${error.message}`);
    }
}

async function main() {
    try {
        const chainlinkNodes = await loadNodesFromFile('./nodes.json');
        for (const chainlinkNode of chainlinkNodes) {
            logger.info(`Retrieving jobs for ${chainlinkNode.name}.`)
            await retrieveJobs(chainlinkNode);
        }

        for (const [chainName, jobs] of Object.entries(activeJobs)) {
            let jobListAddresses = [];
            let jobListFull = []
            logger.info(`Retrieved jobs for ${chainName}: ${jobs.length}`);
            for (const job of jobs) {
                // logger.info(`Job Name: ${job.name}, Contract Address: ${job.contract}`);
                jobListAddresses.push(job.contract);
                jobListFull.push(job)
            }
            logger.info(`Writing retrieved job data to file.`)
            fs.writeFile(`./contracts/${chainName}.json`, JSON.stringify(jobListFull, null, 2), (err) => {
                if (err) {
                    logger.error(`Error writing jobs to /contracts/${chainName}.json: ${err.message}`);
                } else {
                    logger.info(`Successfully wrote job addresses to /contracts/${chainName}.json`);
                }
            });
            logger.info(`Writing retrieved job addresses to file.`)
            fs.writeFile(`./contracts/${chainName}_addresses.json`, JSON.stringify(jobListAddresses, null, 2), (err) => {
                if (err) {
                    logger.error(`Error writing jobs to /contracts/${chainName}_addresses.json: ${err.message}`);
                } else {
                    logger.info(`Successfully wrote job addresses to /contracts/${chainName}_addresses.json`);
                }
            });
        }
    } catch (error) {
        logger.error(`Error in main function: ${error.message}`);
    }
}

main();
