import React, { useState, useEffect } from 'react';
import axios from 'axios';
import CheckboxTree from 'react-checkbox-tree';
import 'react-checkbox-tree/lib/react-checkbox-tree.css';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import './App.css';

const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:5001';

// Set colors for chart segments (unchanged)
const fixedColors = {
    Yes: '#008000', // green
    'Automation Candidate': '#FFD700', // yellow
    No: '#FF0000'   // red
};

/**
 * Custom label on segment: adds "%" sign
 */
const renderCustomizedLabel = (props) => {
    const { x, y, value } = props;
    return (
        <text
            x={x}
            y={y}
            fill="black"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={14}
        >
            {`${value}%`}
        </text>
    );
};

/**
 * Custom tooltip: displays only "%" without the number of test cases
 */
const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    const { name, value } = payload[0].payload;
    return (
        <div
            style={{
                backgroundColor: '#fff',
                border: '1px solid #ccc',
                padding: '5px',
                borderRadius: '4px'
            }}
        >
            {`${name}: ${value}%`}
        </div>
    );
};

function App() {
    const testrailUrl = 'https://tealium.testrail.io';
    const path = '66';

    const [treeData, setTreeData] = useState([]);
    const [checked, setChecked] = useState([]);
    const [expanded, setExpanded] = useState([]);
    const [chartsData, setChartsData] = useState([]);
    const [loadingChart, setLoadingChart] = useState(false);
    const [editingIndex, setEditingIndex] = useState(null);
    const [draftName, setDraftName] = useState('');
    const [showInfo, setShowInfo] = useState(true); // Controls visibility of the info panel

    // Transform data for CheckboxTree
    const formatTree = (nodes) =>
        nodes.map((node) => ({
            value: node.id.toString(),
            label: node.name,
            parent_id: node.parent_id,
            children: node.children ? formatTree(node.children) : []
        }));

    const getAllNodeValues = (nodes) => {
        let values = [];
        nodes.forEach((node) => {
            values.push(node.value);
            if (node.children && node.children.length > 0) {
                values = values.concat(getAllNodeValues(node.children));
            }
        });
        return values;
    };

    // Fetch sections structure (using folders URL, unchanged)
    const fetchSections = async () => {
        try {
            const response = await axios.post(`${apiUrl}/api/testrail/folders`, {
                testrailUrl,
                path
            });
            const formattedTree = formatTree(response.data);
            setTreeData(formattedTree);
            setExpanded([]);
        } catch (error) {
            console.error('Error fetching section structure:', error);
        }
    };

    useEffect(() => {
        fetchSections();
    }, []);

    const expandAll = () => {
        setExpanded(getAllNodeValues(treeData));
    };

    const collapseAll = () => {
        setExpanded([]);
    };

    const findNodeById = (nodes, id) => {
        for (let node of nodes) {
            if (node.value === id.toString()) return node;
            if (node.children && node.children.length > 0) {
                const found = findNodeById(node.children, id);
                if (found) return found;
            }
        }
        return null;
    };

    /**
     * Create a new chart. The name is always "Automation Coverage Chart"
     */
    const buildChart = async () => {
        if (!checked.length) return;
        setLoadingChart(true);
        try {
            // Use folder IDs as-is
            const folderIds = checked.map((id) => parseInt(id, 10));
            const response = await axios.post(`${apiUrl}/api/testrail/data`, {
                testrailUrl,
                folderIds
            });

            const chartTitle = 'Automation Coverage Chart';

            const newChart = {
                ...response.data,
                title: chartTitle,
                candidateTests: response.data.candidateTests || [],
                noTests: response.data.noTests || []
            };

            const oldCharts = chartsData.map((c) => ({
                ...c,
                candidateTests: [],
                noTests: []
            }));

            setChartsData([newChart, ...oldCharts]);
        } catch (error) {
            console.error('Error building chart:', error);
        } finally {
            setLoadingChart(false);
        }
    };

    // Hide elements during export
    const hideNoExportElements = () => {
        const elements = document.querySelectorAll('.no-export');
        elements.forEach(el => {
            el.setAttribute('data-old-display', el.style.display || '');
            el.style.display = 'none';
        });
    };

    const showNoExportElements = () => {
        const elements = document.querySelectorAll('.no-export');
        elements.forEach(el => {
            const oldDisplay = el.getAttribute('data-old-display');
            el.style.display = oldDisplay;
            el.removeAttribute('data-old-display');
        });
    };

    /**
     * Export all charts to PDF (multi-page)
     */
    const exportToPDF = async () => {
        hideNoExportElements();

        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 10;
        let currentY = margin;
        const maxWidth = pageWidth - margin * 2;
        const scaleFactor = 0.9;

        for (let i = 0; i < chartsData.length; i++) {
            const chartDiv = document.getElementById(`chart-container-${i}`);
            if (!chartDiv) continue;

            const noExports = chartDiv.querySelectorAll('.no-export');
            noExports.forEach(el => {
                el.setAttribute('data-old-display', el.style.display || '');
                el.style.display = 'none';
            });

            const canvas = await html2canvas(chartDiv);

            noExports.forEach(el => {
                const oldDisplay = el.getAttribute('data-old-display');
                el.style.display = oldDisplay;
                el.removeAttribute('data-old-display');
            });

            const imgData = canvas.toDataURL('image/png');
            const canvasWidth = canvas.width;
            const canvasHeight = canvas.height;

            const ratio = (maxWidth * scaleFactor) / canvasWidth;
            const imgWidth = canvasWidth * ratio;
            const imgHeight = canvasHeight * ratio;

            if (currentY + imgHeight > pageHeight - margin) {
                pdf.addPage();
                currentY = margin;
            }

            pdf.addImage(imgData, 'PNG', margin, currentY, imgWidth, imgHeight);
            currentY += imgHeight + 10;
        }

        showNoExportElements();
        pdf.save('charts.pdf');
    };

    // Export a single chart to PNG
    const saveChartAsImage = (chartIndex) => {
        const container = document.getElementById(`chart-container-${chartIndex}`);
        const noExports = container.querySelectorAll('.no-export');
        noExports.forEach(el => {
            el.setAttribute('data-old-display', el.style.display || '');
            el.style.display = 'none';
        });

        html2canvas(container).then((canvas) => {
            noExports.forEach(el => {
                const oldDisplay = el.getAttribute('data-old-display');
                el.style.display = oldDisplay;
                el.removeAttribute('data-old-display');
            });

            const imgData = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.href = imgData;
            link.download = `chart-${chartIndex}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    };

    // Edit chart name
    const startEditingName = (index) => {
        setEditingIndex(index);
        setDraftName(chartsData[index].title);
    };
    const setChartName = (index) => {
        const updated = [...chartsData];
        updated[index].title = draftName || 'Automation Coverage Chart';
        setChartsData(updated);
        setEditingIndex(null);
        setDraftName('');
    };

    // Remove chart
    const removeChart = (index) => {
        setChartsData(prev => prev.filter((_, i) => i !== index));
    };

    // Icons for CheckboxTree
    const customIcons = {
        check: <span className="custom-check-icon">✔</span>,
        uncheck: <span className="custom-uncheck-icon"></span>,
        halfCheck: <span className="custom-half-check-icon">−</span>,
        expandOpen: <span className="custom-expand-icon">▼</span>,
        expandClose: <span className="custom-expand-icon">►</span>
    };

    return (
        <div className="container">
            <h1 className="header">My Coverage</h1>
            <p style={{ textAlign: 'center', color: 'black', fontSize: '16px', marginTop: '-15px', marginBottom: '30px' }}>
                Build your team’s test automation coverage chart in just two clicks 🚀
            </p>

            <div className="section-container">
                {treeData.length > 0 ? (
                    <>
                        {/* Information panel with instructions placed above "TestRail Sections:" */}
                        {showInfo && (
                            <div
                                className="info-panel"
                                style={{
                                    backgroundColor: '#f7f7f7',
                                    border: '1px solid #ddd',
                                    padding: '10px',
                                    borderRadius: '4px',
                                    marginBottom: '15px',
                                    fontSize: '14px',
                                    color: '#333',
                                    position: 'relative'
                                }}
                            >
                                <button
                                    onClick={() => setShowInfo(false)}
                                    style={{
                                        position: 'absolute',
                                        top: '5px',
                                        right: '5px',
                                        border: 'none',
                                        background: 'transparent',
                                        fontSize: '18px',
                                        cursor: 'pointer'
                                    }}
                                    aria-label="Close Instructions"
                                >
                                    &times;
                                </button>
                                <ol style={{ margin: 0, paddingLeft: '20px' }}>
                                    <li>Select one or multiple TestRail sections</li>
                                    <li>Click "Build Chart"</li>
                                    <li>Enjoy your charts 🙌</li>
                                </ol>
                            </div>
                        )}
                        <div className="section-header">
                            <span className="section-title">TestRail Sections:</span>
                            <div className="button-group">
                                <button onClick={expandAll} className="btn btn-light">Expand All Sections</button>
                                <button onClick={collapseAll} className="btn btn-light">Collapse All Sections</button>
                            </div>
                        </div>
                        <CheckboxTree
                            nodes={treeData}
                            checked={checked}
                            expanded={expanded}
                            onCheck={setChecked}
                            onExpand={setExpanded}
                            showNodeIcon={false}
                            icons={customIcons}
                        />
                    </>
                ) : (
                    <div>Loading sections...</div>
                )}
            </div>

            <div className="action-buttons">
                <button onClick={buildChart} className="btn">Build Chart</button>
                <button onClick={exportToPDF} className="btn btn-secondary">Download PDF Report</button>
            </div>

            {loadingChart && (
                <div className="nyan-cat-wrapper">
                    <img
                        src="https://media.giphy.com/media/sIIhZliB2McAo/giphy.gif"
                        alt="Loading..."
                        className="nyan-cat-gif"
                    />
                    <p style={{ marginTop: '10px', fontWeight: 'bold', color: 'black' }}>
                        Building chart...
                    </p>
                </div>
            )}

            <div id="pdf-content">
                {chartsData.map((chart, index) => {
                    const dataArr = [
                        { name: 'Yes', value: Number(chart.percentages.Yes) },
                        { name: 'Automation Candidate', value: Number(chart.percentages['Automation Candidate']) },
                        { name: 'No', value: Number(chart.percentages.No) }
                    ];

                    return (
                        <div key={index} id={`chart-container-${index}`} className="chart-container">
                            <div className="chart-header">
                                <h2 className="chart-title">{chart.title}</h2>
                                <div className="no-export chart-header-buttons" style={{ gap: '10px' }}>
                                    <button
                                        className="btn btn-light change-name-btn"
                                        onClick={() => startEditingName(index)}
                                    >
                                        Rename Chart
                                    </button>
                                    <button
                                        className="btn remove-chart-btn icon-button"
                                        onClick={() => removeChart(index)}
                                        title="Remove Chart"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="16"
                                            height="16"
                                            fill="currentColor"
                                            viewBox="0 0 16 16"
                                        >
                                            <path d="M2.5 1a1 1 0 0 1 1-1h9a1 1
                                                   0 0 1 1 1v1h2.5a.5.5 0 0
                                                   1 0 1h-1.223l-1.106
                                                   12.243A2 2 0 0 1 10.677
                                                   16H5.323a2 2 0 0 1-1.994-1.757L2.223
                                                   3H1.5a.5.5 0 0 1 0-1H4V1zm3
                                                   0v1h4V1H5.5z" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {editingIndex === index && (
                                <div className="edit-chart-form no-export">
                                    <input
                                        type="text"
                                        className="edit-chart-input"
                                        value={draftName}
                                        onChange={(e) => setDraftName(e.target.value)}
                                    />
                                    <button
                                        className="btn btn-light save-name-btn"
                                        onClick={() => setChartName(index)}
                                    >
                                        Apply Title
                                    </button>
                                </div>
                            )}

                            <PieChart width={500} height={300}>
                                <Pie
                                    data={dataArr}
                                    dataKey="value"
                                    cx={180}
                                    cy={150}
                                    innerRadius={50}
                                    outerRadius={80}
                                    label={renderCustomizedLabel}
                                >
                                    {dataArr.map((entry, idx) => (
                                        <Cell
                                            key={`cell-${idx}`}
                                            fill={fixedColors[entry.name] || '#8884d8'}
                                        />
                                    ))}
                                </Pie>
                                <Legend layout="vertical" align="right" verticalAlign="middle" />
                                <Tooltip content={<CustomTooltip />} />
                            </PieChart>

                            <div className="chart-info">
                                Overall Automation Coverage: {chart.overallCoverage}%
                            </div>

                            <button
                                onClick={() => saveChartAsImage(index)}
                                className="btn btn-secondary no-export"
                                style={{ marginTop: '10px' }}
                            >
                                Download Chart Image
                            </button>

                            {(chart.candidateTests.length > 0 || chart.noTests.length > 0) && (
                                <>
                                    <div className="test-case-list no-export">
                                        <details>
                                            <summary>
                                                Automation Candidate Test Cases ({chart.candidateTests.length})
                                            </summary>
                                            <ul>
                                                {chart.candidateTests.map((tc) => (
                                                    <li key={tc.id}>
                                                        <strong>ID:</strong> {tc.id} &mdash; <strong>Title:</strong> {tc.title}
                                                    </li>
                                                ))}
                                            </ul>
                                        </details>
                                    </div>
                                    <div className="test-case-list no-export">
                                        <details>
                                            <summary>
                                                Not Automated Test Cases ({chart.noTests.length})
                                            </summary>
                                            <ul>
                                                {chart.noTests.map((tc) => (
                                                    <li key={tc.id}>
                                                        <strong>ID:</strong> {tc.id} &mdash; <strong>Title:</strong> {tc.title}
                                                    </li>
                                                ))}
                                            </ul>
                                        </details>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>

            <footer className="footer">Created by valeria.sholomova</footer>
        </div>
    );
}

export default App;
