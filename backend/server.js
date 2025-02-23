// backend/server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());

// Configure CORS for requests from the allowed origin
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handling preflight requests
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'http://localhost:3000');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200);
});

// Rate limiting to protect against DoS attacks
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // maximum of 100 requests per IP in 15 minutes
});
app.use(limiter);

// Configuration variables from the environment
const projectId = process.env.TESTRAIL_PROJECT_ID || 1;
const suiteId = process.env.TESTRAIL_SUITE_ID || 1;
const testrailUrl = process.env.TESTRAIL_URL || 'https://tealium.testrail.io';
const userEmail = process.env.TESTRAIL_USER_EMAIL || 'your-email@example.com';
const apiKey = process.env.TESTRAIL_API_KEY || 'your_api_key';
const authToken = Buffer.from(`${userEmail}:${apiKey}`).toString('base64');

/**
 * Endpoint to fetch the folder tree (sections) from TestRail.
 */
app.post('/api/testrail/folders',
    body('path').optional().isString(),
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()){
            return res.status(400).json({ errors: errors.array() });
        }
        const { path: userPath } = req.body;
        console.log(`[FOLDERS] Request received. path=${userPath}`);
        try {
            const response = await axios.get(`${testrailUrl}/index.php?/api/v2/get_sections/${projectId}&suite_id=${suiteId}`, {
                headers: { 'Authorization': `Basic ${authToken}` }
            });
            console.log('[FOLDERS] Sections fetched');
            const sections = response.data.sections;
            if (!sections || !Array.isArray(sections)) {
                throw new Error('Sections data is not an array');
            }
            const buildTree = (sections, parentId) => {
                return sections
                    .filter(section => section.parent_id == parentId)
                    .map(section => ({
                        id: section.id,
                        name: section.name,
                        parent_id: section.parent_id,
                        children: buildTree(sections, section.id)
                    }));
            };
            const tree = buildTree(sections, null);
            console.log('[FOLDERS] Constructed folder tree');
            res.json(tree);
        } catch (error) {
            console.error('[FOLDERS] Error fetching sections:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Error fetching folder structure from TestRail' });
        }
    }
);

app.post('/api/testrail/data',
    body('folderIds').isArray(),
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()){
            return res.status(400).json({ errors: errors.array() });
        }
        const { folderIds } = req.body;
        console.log(`[DATA] Request received for folderIds: ${folderIds}`);
        try {
            const fetchTestCases = async (folderId) => {
                const url = `${testrailUrl}/index.php?/api/v2/get_cases/${projectId}&suite_id=${suiteId}&section_id=${folderId}`;
                console.log(`[DATA] Fetching test cases for folderId: ${folderId}`);
                const response = await axios.get(url, {
                    headers: { 'Authorization': `Basic ${authToken}` }
                });
                let testCases = response.data;
                if (!Array.isArray(testCases)) {
                    if (testCases && Array.isArray(testCases.cases)) {
                        testCases = testCases.cases;
                    } else {
                        console.error(`[DATA] Expected array but got: ${typeof response.data}`);
                        throw new Error('Test cases response is not an array');
                    }
                }
                console.log(`[DATA] Received ${testCases.length} test cases for folderId: ${folderId}`);
                return testCases;
            };

            let totalCounts = { Yes: 0, 'Automation Candidate': 0, No: 0 };
            let candidateTests = [];
            let noTests = [];

            for (let folderId of folderIds) {
                const testCases = await fetchTestCases(folderId);
                testCases.forEach(testCase => {
                    console.log(`TestCase id=${testCase.id}, custom_automation=${testCase.custom_automation}`);
                    const automationValue = Number(testCase.custom_automation);
                    if (automationValue === 1) {
                        totalCounts.Yes += 1;
                    } else if (automationValue === 3) {
                        totalCounts['Automation Candidate'] += 1;
                        candidateTests.push({ id: testCase.id, title: testCase.title });
                    } else if (automationValue === 2) {
                        totalCounts.No += 1;
                        noTests.push({ id: testCase.id, title: testCase.title });
                    } else {
                        totalCounts.No += 1;
                        noTests.push({ id: testCase.id, title: testCase.title });
                    }
                });
            }

            const total = totalCounts.Yes + totalCounts['Automation Candidate'] + totalCounts.No;
            console.log(`[DATA] Total test cases: ${total}`);
            const percentages = total > 0 ? {
                Yes: (totalCounts.Yes / total * 100).toFixed(1),
                'Automation Candidate': (totalCounts['Automation Candidate'] / total * 100).toFixed(1),
                No: (totalCounts.No / total * 100).toFixed(1)
            } : { Yes: 0, 'Automation Candidate': 0, No: 0 };

            const overallCoverage = percentages.Yes;
            console.log(`[DATA] Percentages calculated. Overall Coverage: ${overallCoverage}%`);

            res.json({ totalCounts, percentages, overallCoverage, candidateTests, noTests });
        } catch (error) {
            console.error('[DATA] Error fetching test case statistics:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Error fetching test case statistics from TestRail' });
        }
    }
);

// Serving static React files from the build folder (located in backend)
app.use(express.static(path.join(__dirname, 'build')));

// For supporting client-side routing, serve index.html for all GET requests
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
