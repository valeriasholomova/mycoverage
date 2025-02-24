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

app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'http://localhost:3000');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200);
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use(limiter);

// Configuration
const projectId = process.env.TESTRAIL_PROJECT_ID || 1;
const suiteId = process.env.TESTRAIL_SUITE_ID || 1;
const testrailUrl = process.env.TESTRAIL_URL || 'https://tealium.testrail.io';
const userEmail = process.env.TESTRAIL_USER_EMAIL || 'your-email@example.com';
const apiKey = process.env.TESTRAIL_API_KEY || 'your_api_key';
const authToken = Buffer.from(`${userEmail}:${apiKey}`).toString('base64');

/**
 * Fetch all sections with pagination
 */
const fetchAllSections = async () => {
    let allSections = [];
    let offset = 0;
    const limit = 250;
    let fetched = 0;
    do {
        const url = `${testrailUrl}/index.php?/api/v2/get_sections/${projectId}&suite_id=${suiteId}&offset=${offset}&limit=${limit}`;
        console.log(`[SECTIONS] Fetching sections with offset=${offset} and limit=${limit}`);
        const response = await axios.get(url, {
            headers: { 'Authorization': `Basic ${authToken}` }
        });
        const sectionsBatch = response.data.sections;
        if (!sectionsBatch || !Array.isArray(sectionsBatch)) {
            throw new Error('Sections data is not an array');
        }
        allSections = allSections.concat(sectionsBatch);
        fetched = sectionsBatch.length;
        offset += fetched;
    } while (fetched === limit);
    return allSections;
};

/**
 * Build a tree of sections based on parent_id (for display)
 */
const buildTree = (sections) => {
    const sectionMap = {};
    sections.forEach(section => {
        sectionMap[section.id] = { ...section, children: [] };
    });
    const roots = [];
    sections.forEach(section => {
        if (section.parent_id !== null && section.parent_id !== 0 && sectionMap[section.parent_id]) {
            sectionMap[section.parent_id].children.push(sectionMap[section.id]);
        } else {
            roots.push(sectionMap[section.id]);
        }
    });
    return roots;
};

/**
 * Function to fetch all test cases for a given section with pagination
 */
const fetchTestCasesForSection = async (sectionId) => {
    let allTestCases = [];
    let offset = 0;
    const limit = 250;
    let fetched = 0;
    do {
        const url = `${testrailUrl}/index.php?/api/v2/get_cases/${projectId}&suite_id=${suiteId}&section_id=${sectionId}&offset=${offset}&limit=${limit}`;
        console.log(`[CASES] Fetching test cases for section ${sectionId} with offset=${offset} and limit=${limit}`);
        const response = await axios.get(url, {
            headers: { 'Authorization': `Basic ${authToken}` }
        });
        let batch = response.data;
        if (!Array.isArray(batch)) {
            if (batch && Array.isArray(batch.cases)) {
                batch = batch.cases;
            } else {
                console.error(`[CASES] Expected array for test cases but got: ${typeof response.data}`);
                throw new Error('Test cases response is not an array');
            }
        }
        allTestCases = allTestCases.concat(batch);
        fetched = batch.length;
        offset += fetched;
    } while (fetched === limit);
    console.log(`[CASES] Section ${sectionId} total test cases: ${allTestCases.length}`);
    return allTestCases;
};

/**
 * Endpoint for fetching section structure
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
            const sections = await fetchAllSections();
            console.log('[FOLDERS] Total sections fetched:', sections.length);
            const tree = buildTree(sections);
            console.log('[FOLDERS] Constructed folder tree with', tree.length, 'root nodes');
            res.json(tree);
        } catch (error) {
            console.error('[FOLDERS] Error fetching sections:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Error fetching folder structure from TestRail', details: error.response ? error.response.data : error.message });
        }
    }
);

/**
 * Endpoint for fetching test case statistics.
 * Here we build the final set of sections as follows:
 * - Include all selected sections (folderIds)
 * - Add all their ancestors (to fetch test cases from parent sections)
 * - Add all their descendants
 */
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
            // 1. Fetch all sections
            const allSections = await fetchAllSections();
            console.log('[DATA] Total sections fetched:', allSections.length);

            // 2. Build a parentMap
            const parentMap = {};
            allSections.forEach(section => {
                parentMap[section.id] = section.parent_id;
            });

            // 3. For each selected id, add it, its ancestors, and its descendants
            const selectedIds = folderIds.map(id => Number(id));
            const allFolderIdsSet = new Set();
            // Add selected sections
            selectedIds.forEach(id => allFolderIdsSet.add(id));
            // Add ancestors of selected sections
            selectedIds.forEach(id => {
                let current = parentMap[id];
                while (current && current !== 0) {
                    allFolderIdsSet.add(current);
                    current = parentMap[current];
                }
            });
            // Add descendants: for each section, if one of its ancestors is selected, add it
            allSections.forEach(section => {
                let current = parentMap[section.id];
                while (current && current !== 0) {
                    if (selectedIds.includes(current)) {
                        allFolderIdsSet.add(section.id);
                        break;
                    }
                    current = parentMap[current];
                }
            });
            const allFolderIds = Array.from(allFolderIdsSet);
            console.log('[DATA] All folder IDs to process:', allFolderIds);

            // 4. Fetch test cases for all sections in parallel
            const testCasesResults = await Promise.all(
                allFolderIds.map(id =>
                    fetchTestCasesForSection(id).catch(err => {
                        console.error(`Error fetching test cases for section ${id}:`, err.message);
                        return [];
                    })
                )
            );
            const allTestCases = [].concat(...testCasesResults);
            console.log('[DATA] Total test cases fetched:', allTestCases.length);

            // 5. Aggregate statistics
            let totalCounts = { Yes: 0, 'Automation Candidate': 0, No: 0 };
            let candidateTests = [];
            let noTests = [];
            allTestCases.forEach(testCase => {
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

            const total = totalCounts.Yes + totalCounts['Automation Candidate'] + totalCounts.No;
            const percentages = total > 0 ? {
                Yes: (totalCounts.Yes / total * 100).toFixed(1),
                'Automation Candidate': (totalCounts['Automation Candidate'] / total * 100).toFixed(1),
                No: (totalCounts.No / total * 100).toFixed(1)
            } : { Yes: 0, 'Automation Candidate': 0, No: 0 };

            const overallCoverage = percentages.Yes;
            console.log(`[DATA] Aggregated total test cases: ${total}`);
            console.log('[DATA] Percentages:', percentages);

            res.json({ totalCounts, percentages, overallCoverage, candidateTests, noTests });
        } catch (error) {
            console.error('[DATA] Error fetching test case statistics:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Error fetching test case statistics from TestRail', details: error.response ? error.response.data : error.message });
        }
    }
);

// Serving static React files from the build folder
app.use(express.static(path.join(__dirname, 'build')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
