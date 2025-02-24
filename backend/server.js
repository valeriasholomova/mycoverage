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
 * Здесь реализована пагинация с limit=250, так как TestRail не позволяет запрашивать больше.
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
            // Функция для последовательного получения всех секций с пагинацией
            const fetchAllSections = async () => {
                let allSections = [];
                let offset = 0;
                const limit = 250;
                let fetched = 0;
                do {
                    const url = `${testrailUrl}/index.php?/api/v2/get_sections/${projectId}&suite_id=${suiteId}&offset=${offset}&limit=${limit}`;
                    console.log(`[FOLDERS] Fetching sections with offset=${offset} and limit=${limit}`);
                    const response = await axios.get(url, {
                        headers: { 'Authorization': `Basic ${authToken}` }
                    });
                    // API возвращает секции в поле "sections"
                    const data = response.data;
                    const sectionsBatch = data.sections;
                    if (!sectionsBatch || !Array.isArray(sectionsBatch)) {
                        throw new Error('Sections data is not an array');
                    }
                    allSections = allSections.concat(sectionsBatch);
                    fetched = sectionsBatch.length;
                    offset += fetched;
                } while (fetched === limit);
                return allSections;
            };

            const sections = await fetchAllSections();
            console.log('[FOLDERS] Total sections fetched:', sections.length);

            // Функция построения дерева секций на основе parent_id
            const buildTree = (sections) => {
                const sectionMap = {};
                // Инициализируем мапу: каждому узлу добавляем пустой массив children
                sections.forEach(section => {
                    sectionMap[section.id] = { ...section, children: [] };
                });
                const roots = [];
                sections.forEach(section => {
                    // Если parent_id не равен null и не равен 0, и родитель присутствует в мапе – добавляем в его children
                    if (section.parent_id !== null && section.parent_id !== 0 && sectionMap[section.parent_id]) {
                        sectionMap[section.parent_id].children.push(sectionMap[section.id]);
                    } else {
                        // Иначе считаем секцию корневой
                        roots.push(sectionMap[section.id]);
                    }
                });
                return roots;
            };

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
 * Endpoint to fetch test cases for selected folder IDs and calculate automation coverage.
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
