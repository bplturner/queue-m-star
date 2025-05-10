// ============================
// Global Configuration
// ============================

// DEBUG flag to control console logging. Set to 'false' to disable debug logs.
const DEBUG = true;

// Helper function for conditional logging based on the DEBUG flag.
function logDebug(message, ...optionalParams) {
    if (DEBUG) {
        console.log(message, ...optionalParams);
    }
}

// ============================
// Encapsulate Code to Prevent Global Namespace Pollution
// ============================

(function() {
    // ============================
    // Global Variables
    // ============================

    let currentPid = null;             // Stores the current process ID.
    let refreshInterval = null;        // Holds the reference to the interval timer for refreshing output.
    let autoScroll = true;             // Determines whether the output should auto-scroll.
    let lastTimeStepData = null;       // Stores the data of the last time step.
    let scrollTimeout;                  // Holds the reference to the scroll timeout.

    // ============================
    // Utility Functions
    // ============================

    /**
     * Parses all iteration blocks from the process output.
     * @param {string} output - The complete log output as a string.
     * @returns {Array} - An array of parsed iteration objects.
     */
    function parseAllIterations(output) {
        logDebug('parseAllIterations called');
        const delimiter = '--------------------------------------------------'; // Define the delimiter used to separate iteration blocks.
        const rawBlocks = output.split(delimiter).map(block => block.trim()).filter(block => block !== ''); // Split and clean the blocks.

        const parsedIterations = []; // Initialize an array to store the parsed iterations.

        rawBlocks.forEach((iterBlock, index) => {
            const parsedData = parseIterationBlock(iterBlock); // Parse each iteration block.
            if (parsedData.iterationNumber !== null && parsedData.time !== null && Object.keys(parsedData.performance).length > 0) {
                parsedIterations.push(parsedData); // Add valid parsed data to the array.
                logDebug(`Parsed Block ${index + 1}:`, parsedData); // Log the parsed block for debugging.
            } else {
                logDebug(`Skipped Incomplete or Invalid Block ${index + 1}`);
            }
        });

        return parsedIterations; // Return the array of parsed iterations.
    }

    /**
     * Parses a single iteration block to extract iteration number, time, and performance statistics.
     * @param {string} block - The iteration block as a string.
     * @returns {object} - An object containing the parsed iteration data.
     */
    function parseIterationBlock(block) {
        logDebug('parseIterationBlock called with block:', block);
        const iterationData = {
            iterationNumber: null, // Placeholder for iteration number.
            time: null,            // Placeholder for time.
            performance: {}        // Placeholder for performance data.
        };

        const lines = block.split('\n').map(line => line.trim()).filter(line => line !== ''); // Split and clean lines.

        let isPerformanceSection = false; // Flag to indicate if the parser is within the Performance section.

        lines.forEach(line => {
            if (line.startsWith('Iteration')) {
                const match = line.match(/Iteration\s+(\d+)/); // Extract iteration number using regex.
                if (match) {
                    iterationData.iterationNumber = parseInt(match[1], 10); // Assign iteration number.
                    logDebug('Extracted Iteration Number:', iterationData.iterationNumber);
                }
            }

            if (line.startsWith('Time =')) {
                const match = line.match(/Time\s*=\s*([\d.eE+-]+)\s*s/); // Extract time in seconds using regex.
                if (match) {
                    iterationData.time = parseFloat(match[1]); // Assign time.
                    logDebug('Extracted Time:', iterationData.time);
                }
            }

            if (line.startsWith('Performance:')) {
                isPerformanceSection = true; // Entering Performance section.
                logDebug('Entering Performance section');
                return; // Skip processing this line as it's a header.
            }

            if (isPerformanceSection) {
                if (line.endsWith(':') && !line.includes('=')) {
                    isPerformanceSection = false; // Exiting Performance section.
                    logDebug('Exiting Performance section');
                    return;
                }

                const [key, value] = line.split('=').map(part => part.trim()); // Split line into key and value.
                if (key && value) {
                    const cleanKey = key.replace(/\s*\(.*\)/, ''); // Remove any units from the key.
                    iterationData.performance[cleanKey] = isNaN(parseFloat(value)) ? value : parseFloat(value); // Assign value.
                    logDebug(`Extracted Performance Data - ${cleanKey}:`, iterationData.performance[cleanKey]);
                }
            }
        });

        return iterationData; // Return the populated iteration data object.
    }

    /**
     * Parses the global parameters from the process output.
     * @param {string} output - The complete log output as a string.
     * @returns {object} - An object containing the parsed global parameters.
     */
    function parseGlobalParameters(output) {
        logDebug('parseGlobalParameters called');
        const globalParams = {}; // Initialize an empty object to store global parameters.
        const sections = output.split(/<<<<<<[^>]+>>>>>>/g); // Split the output into sections based on the delimiter pattern.

        const initialSection = sections[0]; // Extract the initial section before the first delimiter.
        const initialLines = initialSection.split('\n').map(line => line.trim()).filter(line => line !== ''); // Split and clean lines.

        if (initialLines.length > 0) {
            const firstLine = initialLines[0]; // Get the first line of the initial section.
            if (!firstLine.includes(':') && !firstLine.includes('=')) { // Check if the first line lacks key-value separators.
                const match = firstLine.match(/(.+)\s*\((.+)\)/); // Use regex to extract key and value.
                if (match) {
                    const key = match[1].trim();
                    const value = match[2].trim();
                    globalParams[key] = value; // Assign to global parameters.
                    logDebug('Extracted Global Param:', key, '=', value);
                } else {
                    globalParams[firstLine] = ''; // Assign empty string if no match.
                    logDebug('Assigned Empty Value to Global Param:', firstLine);
                }
            }
        }

        for (let i = 1; i < initialLines.length; i++) { // Iterate over remaining lines in the initial section.
            const line = initialLines[i];
            if (line.includes(':')) { // Check for key-value separator ':'.
                const [key, ...rest] = line.split(':');
                const value = rest.join(':').trim(); // Join remaining parts as value.
                globalParams[key.trim()] = value; // Assign to global parameters.
                logDebug('Extracted Global Param:', key.trim(), '=', value);
            }
        }

        for (let s = 1; s < sections.length; s++) { // Iterate over each additional section after the first delimiter.
            const section = sections[s];
            const lines = section.split('\n').map(line => line.trim()).filter(line => line !== ''); // Split and clean lines.
            if (lines.length === 0) continue; // Skip empty sections.

            const categoryName = lines[0]; // The first line is the category name.
            globalParams[categoryName] = {}; // Initialize the category in global parameters.
            logDebug('Processing Category:', categoryName);

            for (let i = 1; i < lines.length; i++) { // Iterate over remaining lines in the section.
                const line = lines[i];
                if (line.includes('=')) { // Check for key-value separator '='.
                    const [key, ...rest] = line.split('=');
                    const value = rest.join('=').trim(); // Join remaining parts as value.
                    globalParams[categoryName][key.trim()] = isNaN(parseFloat(value)) ? value : parseFloat(value); // Assign to category.
                    logDebug(`Extracted ${categoryName} - ${key.trim()}:`, globalParams[categoryName][key.trim()]);
                }
            }
        }

        return globalParams; // Return the complete global parameters object.
    }

    /**
     * Extracts a mapping of variable names to their units from the process output.
     * @param {string} output - The complete log output as a string.
     * @returns {object} - An object mapping variable names to their units.
     */
    function extractVarUnitMap(output) {
        logDebug('extractVarUnitMap called');
        const varUnitMap = {}; // Initialize an empty object to store variable-unit mappings.
        const sections = output.split(/<<<<<<[^>]+>>>>>>/g); // Split the output into sections based on the delimiter pattern.

        sections.forEach(section => { // Iterate over each section to find global variable definitions.
            const lines = section.split('\n').map(line => line.trim()).filter(line => line !== ''); // Split and clean lines.
            if (lines.length === 0) return; // Skip empty sections.

            if (lines[0] === 'Global Variable') { // Check if the section defines a Global Variable.
                let varName = ''; // Variable name.
                let unit = 'No Units'; // Default unit.

                lines.forEach(line => { // Iterate over each line to extract the name and unit.
                    if (line.startsWith('Name =')) { // Check for variable name.
                        varName = line.split('=')[1].trim(); // Extract variable name.
                        logDebug('Found Variable Name:', varName);
                    }
                    if (line.startsWith('Units =')) { // Check for variable units.
                        const parsedUnit = line.split('=')[1].trim(); // Extract units.
                        if (parsedUnit) {
                            unit = parsedUnit; // Assign parsed unit if available.
                            logDebug(`Found Units for ${varName}:`, unit);
                        }
                    }
                });

                if (varName) { // If a variable name was found, map it to its unit.
                    varUnitMap[varName] = unit;
                    logDebug(`Mapped Variable to Unit: ${varName} = ${unit}`);
                }
            }
        });

        return varUnitMap; // Return the complete variable-unit mapping.
    }

    /**
     * Populates the HTML table with the parsed iteration data.
     * @param {Array} parsedIterations - An array of parsed iteration objects.
     */
    function populateIterationTable(parsedIterations) {
        // Log debug information about the function call and its parameters.
        logDebug('populateIterationTable called with iterations:', parsedIterations);
        
        // Select the table body element from the DOM.
        const tableBody = document.querySelector('#iterationTable tbody');
        
        // Check if the table body element exists.
        if (!tableBody) {
            // Log an error if the table body is not found.
            console.error("Table body element not found. Unable to populate iteration table.");
            return; // Exit the function if the table body doesn't exist.
        }
        
        // Check if there are any iterations to process
        if (parsedIterations.length === 0) {
            logDebug('No iterations to update.');
            return;
        }

        // Get the latest iteration
        const latestIter = parsedIterations[parsedIterations.length - 1];

        //Call the displayLastTimeStep function with the latest iteration data
        displayLastTimeStep(latestIter);
    
    }

    /**
     * Displays the details of the last time step in the designated container.
     * @param {object} ts - The last time step data object.
     */
    function displayLastTimeStep(ts) {
        logDebug('displayLastTimeStep called with data:', ts);
        const table = document.getElementById('iterationTable');
        if (!table) {
            console.warn("Table with id 'iterationTable' not found");
            return;
        }

        // Check if thead exists, if not create it
        let thead = table.querySelector('thead');
        if (!thead) {
            thead = document.createElement('thead');
            table.appendChild(thead);
        }

        // Check if tbody exists, if not create it
        let tbody = table.querySelector('tbody');
        if (!tbody) {
            tbody = document.createElement('tbody');
            table.appendChild(tbody);
        }

        // Clear existing thead and tbody contents
        thead.innerHTML = '';
        tbody.innerHTML = '';

        if (!ts) {
            // If no data is available, display a message spanning all columns
            const noDataRow = document.createElement('tr');
            const noDataCell = document.createElement('th');
            noDataCell.textContent = 'No iteration data found.';
            noDataCell.colSpan = 10; // Adjust colspan based on the number of columns
            noDataRow.appendChild(noDataCell);
            thead.appendChild(noDataRow);
            return;
        }

        // Dynamically create table headers based on the keys of the data object
        const headers = Object.keys(ts);
        const headerRow = document.createElement('tr');
        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);

        // Create a table row with the corresponding data
        const dataRow = document.createElement('tr');
        headers.forEach(key => {
            const td = document.createElement('td');
            td.textContent = ts[key] !== undefined ? ts[key] : 'N/A';
            dataRow.appendChild(td);
        });
        tbody.appendChild(dataRow);

        logDebug('Last time step data displayed dynamically.');
    }
    /**
     * Handles the scroll event on the process output content to manage auto-scrolling.
     */
    function handleScroll() {
        clearTimeout(scrollTimeout); // Clear any existing scroll timeout to debounce the event.

        scrollTimeout = setTimeout(() => { // Set a new timeout to check the scroll position after a short delay.
            const element = document.getElementById('processOutputContent'); // Get the process output content element.

            if (!element) { // Check if the element exists.
                console.error("Process output content element not found.");
                return;
            }

            // Check if the user has scrolled to the bottom of the content.
            if (element.scrollHeight - element.scrollTop === element.clientHeight) {
                autoScroll = true; // Enable auto-scroll if at the bottom.
                logDebug('Auto-scroll enabled');
            } else {
                autoScroll = false; // Disable auto-scroll if not at the bottom.
                logDebug('Auto-scroll disabled');
            }
        }, 100); // Delay in milliseconds.
    }

    /**
     * Updates the refresh interval by restarting the interval timer with a new value.
     */
    function updateRefreshInterval() {
        logDebug('updateRefreshInterval called');
        startRefreshInterval(); // Restart the interval timer with the updated interval value.
    }
window.updateRefreshInterval = updateRefreshInterval;

    /**
     * Starts the interval timer to refresh the process output at specified intervals.
     */
    function startRefreshInterval() {
        stopRefreshInterval(); // Stop any existing interval to prevent multiple timers.

        const intervalSeconds = parseFloat(document.getElementById('updateInterval').value); // Retrieve the refresh interval value from the DOM.

        if (isNaN(intervalSeconds) || intervalSeconds <= 0) { // Validate the interval value.
            alert('Please enter a valid positive number for the update interval.');
            logDebug('Invalid update interval entered:', intervalSeconds);
            return;
        }

        const interval = intervalSeconds * 1000; // Convert seconds to milliseconds.
        refreshInterval = setInterval(refreshProcessOutput, interval); // Set up a new interval timer.
        logDebug(`Refresh interval set to ${intervalSeconds} seconds`);
    }

    /**
     * Stops the interval timer that refreshes the process output.
     */
    function stopRefreshInterval() {
        if (refreshInterval !== null) { // Check if an interval timer is active.
            clearInterval(refreshInterval); // Clear the interval timer.
            refreshInterval = null; // Reset the interval reference.
            logDebug('Refresh interval stopped');
        }
    }

    /**
     * Fetches the process output data from the server and updates the UI accordingly.
     */
    function refreshProcessOutput() {
        if (currentPid === null) { // If there's no current PID, exit the function.
            logDebug('No current PID set. Exiting refreshProcessOutput.');
            return;
        }

        logDebug(`Refreshing process output for PID: ${currentPid}`);

        fetch(`/process/${currentPid}`) // Fetch the process output data from the server.
            .then(response => {
                if (!response.ok) { // Check if the response is successful.
                    throw new Error('Network response was not ok');
                }
                return response.text(); // Convert the response to text.
            })
            .then(data => {
                const outputContent = document.getElementById('processOutputContent'); // Get the DOM element that displays the process output.

                if (!outputContent) { // Check if the output content element exists.
                    console.error("Process output content element not found.");
                    return;
                }

                outputContent.textContent = data; // Update the content with the fetched data.

                if (autoScroll) { // If auto-scroll is enabled, scroll to the bottom of the content.
                    outputContent.scrollTop = outputContent.scrollHeight;
                    logDebug('Auto-scrolled to the bottom of process output content');
                }

                parseLastTimeStep(data); // Parse and update the display for the last time step.
            })
            .catch(error => {
                console.error('Error fetching process output:', error); // Log any errors that occur during the fetch.
            });
    }

    /**
     * Handles the file upload process by sending the selected file to the server via AJAX.
     * @param {Event} event - The event triggered by the form submission.
     */
    function uploadFile(event) {
        event.preventDefault(); // Prevent the default form submission behavior.
        logDebug('uploadFile called');

        const fileInput = document.getElementById('fileInput'); // Get the file input element by its ID.

        if (!fileInput) { // Check if the file input exists.
            console.error("File input element with id 'fileInput' not found.");
            return;
        }

        const file = fileInput.files[0]; // Retrieve the first file selected by the user.

        if (!file) { // Check if a file has been selected.
            alert('Please select a file'); // Alert the user to select a file if none is chosen.
            logDebug('No file selected for upload.');
            return;
        }

        // Validate file size (e.g., limit to 10MB).
        const maxSize = 10 * 1024 * 1024; // 10MB in bytes.
        if (file.size > maxSize) { // Check if the file size exceeds the limit.
            alert('File size exceeds the 10MB limit.'); // Alert the user.
            logDebug(`Selected file size (${file.size} bytes) exceeds the maximum allowed.`);
            return;
        }

        // Validate file type (e.g., allow only .msb files).
        const allowedTypes = ['application/octet-stream', 'application/msb']; // Adjust MIME types as needed.
        if (!allowedTypes.includes(file.type)) { // Check if the file type is allowed.
            alert('Invalid file type. Please upload a valid MSB file.'); // Alert the user.
            logDebug(`Selected file type (${file.type}) is not allowed.`);
            return;
        }

        const xhr = new XMLHttpRequest(); // Create a new XMLHttpRequest object for AJAX communication.
        xhr.open('POST', `/upload-msb?filename=${encodeURIComponent(file.name)}`, true); // Initialize a POST request with the filename as a query parameter.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream'); // Set the content type header to indicate binary data.

        xhr.onload = function() { // Define the callback function to execute when the request state changes.
            if (xhr.status === 200) { // Check if the upload was successful.
                const uploadStatus = document.getElementById('uploadStatus'); // Get the upload status element.
                if (uploadStatus) {
                    uploadStatus.textContent = 'File uploaded successfully!'; // Update the upload status to indicate success.
                }

                const form = fileInput.closest('form'); // Attempt to reset the closest form element to clear inputs.
                if (form) {
                    form.reset(); // Reset the form if found.
                } else {
                    fileInput.value = ''; // If no form is found, manually clear the file input value.
                }

                setTimeout(() => { // After a 2-second delay, hide the upload popup and redirect to the GPU status page.
                    const uploadPopup = document.getElementById('uploadPopup'); // Get the upload popup element.
                    if (uploadPopup) {
                        uploadPopup.style.display = 'none'; // Hide the upload popup.
                        logDebug('Upload popup hidden after successful upload.');
                    }

                    window.location.href = '/gpu-status'; // Redirect to the GPU status page.
                    logDebug('Redirected to /gpu-status');
                }, 2000); // 2000 milliseconds = 2 seconds.
            } else { // If the upload fails.
                const uploadStatus = document.getElementById('uploadStatus'); // Get the upload status element.
                if (uploadStatus) {
                    uploadStatus.textContent = 'Upload failed: ' + xhr.responseText; // Display the error message returned from the server.
                }
                logDebug('File upload failed with status:', xhr.status, 'Response:', xhr.responseText);
            }
        };

        xhr.onerror = function() { // Handle network errors.
            const uploadStatus = document.getElementById('uploadStatus'); // Get the upload status element.
            if (uploadStatus) {
                uploadStatus.textContent = 'Upload failed due to a network error.'; // Display a network error message.
            }
            logDebug('File upload failed due to a network error.');
        };

        xhr.send(file); // Send the file data to the server.
        logDebug(`File "${file.name}" sent to server for upload.`);
    }

    /**
     * Displays the process output popup for a given PID and MSB file.
     * @param {number} pid - The process ID to monitor.
     * @param {string} msbFile - The name of the MSB file associated with the process.
     */
    function showProcessOutput(pid, msbFile) {
        logDebug('showProcessOutput called with PID:', pid, 'MSB File:', msbFile);
        currentPid = pid; // Set the current process ID.

        const processOutputTitle = document.getElementById('processOutputTitle'); // Get the process output title element.
        if (processOutputTitle) {
            processOutputTitle.textContent = `Output for ${msbFile} (PID: ${pid})`; // Update the title with the MSB file name and PID.
        }

        const processOutputPopup = document.getElementById('processOutputPopup'); // Get the process output popup element.
        if (processOutputPopup) {
            processOutputPopup.classList.add('visible'); // Add 'visible' class instead of setting style directly
            logDebug('Process output popup displayed.');
        }

        refreshProcessOutput(); // Fetch and display the initial process output.
        startRefreshInterval(); // Start the interval timer to refresh the process output periodically.

        const plotButton = document.getElementById('plot-button'); // Get the plot button element.
        if (plotButton) {
            plotButton.style.display = 'inline-block'; // Make the plot button visible.
            logDebug('Plot button made visible.');
        }
    }

// Expose the function globally
window.showProcessOutput = showProcessOutput;

    /**
     * Closes the process output popup and stops refreshing the output.
     */
    function closeProcessOutput() {
        logDebug('closeProcessOutput called');
        const processOutputPopup = document.getElementById('processOutputPopup'); // Get the process output popup element.
        if (processOutputPopup) {
            processOutputPopup.classList.remove('visible'); // Remove 'visible' class
            logDebug('Process output popup hidden.');
        }

        stopRefreshInterval(); // Stop the interval timer for refreshing output.

        const plotButton = document.getElementById('plot-button'); // Get the plot button element.
        if (plotButton) {
            plotButton.style.display = 'none'; // Hide the plot button.
            logDebug('Plot button hidden.');
        }
    }

    /**
     * Parses the last complete time step from the process output data.
     * @param {string} data - The complete process output data as a string.
     */
    function parseLastTimeStep(data) {
        const delimiter = '--------------------------------------------------';
        const blocks = data.split(delimiter).map(block => block.trim()).filter(block => block !== '');

        logDebug(`Total blocks found: ${blocks.length}`);

        for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i];
            logDebug(`Checking Block ${i + 1}:`, block);

            const lines = block.split('\n').map(line => line.trim()).filter(line => line !== '');
            logDebug(`Lines in Block ${i + 1}:`, lines);

            if (!lines[0].startsWith('Iteration')) {
                logDebug(`Block ${i + 1} does not start with 'Iteration'. Skipping.`);
                continue;
            }

            // Ensure the first three lines are correct
            if (
                lines.length >= 3 &&
                lines[0].startsWith('Iteration') &&
                lines[1].startsWith('Time =') &&
                lines[2].startsWith('TimeStep =')
            ) {
                const iterationMatch = lines[0].match(/Iteration\s+(\d+)/);
                const timeMatch = lines[1].match(/Time\s*=\s*([\d.eE+-]+)\s*s/);
                const timeStepMatch = lines[2].match(/TimeStep\s*=\s*([\d.eE+-]+)\s*s/);

                if (!iterationMatch || !timeMatch || !timeStepMatch) {
                    logDebug('Failed to parse Iteration, Time, or TimeStep.');
                    continue;
                }

                // Helper function to find and match a line based on a starting keyword and regex
                const findMatch = (startText, regex) => {
                    const line = lines.find(line => line.startsWith(startText));
                    if (line) {
                        return line.match(regex);
                    }
                    return null;
                };

                // Dynamically locate and match each required line
                const kineticEnergyMatch = findMatch('Total Kinetic Energy', /Total Kinetic Energy\s*\(J\)\s*=\s*([\d.eE+-]+)/);
                const maxVelocityMatch = findMatch('Max Velocity', /Max Velocity\s*\(m\/s\)\s*=\s*([\d.eE+-]+)/);
                const lbDensityMatch = findMatch('Min, Max LB Density', /Min,\s*Max LB Density\s*=\s*([\d.eE+-]+),\s*([\d.eE+-]+)/);
                const latticeMatch = findMatch('Lattice', /Lattice\s*\(MUPS\)\s*=\s*([\d.eE+-]+)/);
                const gpuMemCapacityMatch = findMatch('GPU Memory Capacity', /GPU Memory Capacity\s*\(GB\)\s*=\s*([\d.eE+-]+)/);
                const usedGPUMemMatch = findMatch('Used GPU Memory', /Used GPU Memory\s*\(GB\)\s*=\s*([\d.eE+-]+)/);

                // Check if all necessary matches are found
                if (
                    kineticEnergyMatch &&
                    maxVelocityMatch &&
                    lbDensityMatch &&
                    latticeMatch &&
                    gpuMemCapacityMatch &&
                    usedGPUMemMatch
                ) {
                    lastTimeStepData = {
                        Iteration: parseInt(iterationMatch[1], 10),
                        Time: parseFloat(timeMatch[1]),
                        TimeStep: parseFloat(timeStepMatch[1]),
                        TotalKineticEnergy: parseFloat(kineticEnergyMatch[1]),
                        MaxVelocity: parseFloat(maxVelocityMatch[1]),
                        MinLBDensity: parseFloat(lbDensityMatch[1]),
                        MaxLBDensity: parseFloat(lbDensityMatch[2]),
                        LatticeMUPS: parseFloat(latticeMatch[1]),
                        GPUMemoryCapacity: parseFloat(gpuMemCapacityMatch[1]),
                        UsedGPUMemory: parseFloat(usedGPUMemMatch[1])
                    };
                    logDebug('Parsed Last Time Step Data:', lastTimeStepData);
                    displayLastTimeStep(lastTimeStepData);
                    return;
                } else {
                    lastTimeStepData = null;
                    logDebug('Failed to parse some fields in last time step.');
                }
            } else {
                logDebug(`Expected pattern not found in Block ${i + 1}. Continuing to previous blocks.`);
            }
        }

        // If no valid block is found
        lastTimeStepData = null;
        displayLastTimeStep(lastTimeStepData);
        logDebug('No valid block found for parsing last time step.');
    }

    /**
     * Creates checkboxes for each global variable to allow user selection for plotting.
     * @param {object} globalVars - An object containing global variable names as keys.
     * @returns {boolean} - Returns true if checkboxes are created successfully, else false.
     */
    function createVariableCheckboxes(globalVars) {
        logDebug('createVariableCheckboxes called with globalVars:', globalVars);
        const checkboxContainer = document.getElementById('variable-checkboxes'); // Select the container element for the variable checkboxes.

        if (!checkboxContainer) { // Check if the container exists.
            console.error("Element with id 'variable-checkboxes' not found");
            return false;
        }

        checkboxContainer.innerHTML = ''; // Clear any existing checkboxes in the container.

        Object.keys(globalVars).forEach((varName, index) => { // Iterate over each global variable to create corresponding checkboxes.
            const checkboxItem = document.createElement('div'); // Create a new div element to hold the checkbox and its label.
            checkboxItem.className = 'checkbox-item'; // Assign a class name for styling.

            const checkbox = document.createElement('input'); // Create the checkbox input element.
            checkbox.type = 'checkbox'; // Set the input type to checkbox.
            checkbox.id = `var-${index}`; // Assign a unique ID to the checkbox.
            checkbox.name = varName; // Set the name attribute to the variable name.
            checkbox.checked = true; // Set the checkbox to be checked by default.

            const label = document.createElement('label'); // Create the label for the checkbox.
            label.htmlFor = `var-${index}`; // Associate the label with the checkbox.
            label.textContent = varName; // Set the label text to the variable name.

            checkboxItem.appendChild(checkbox); // Append the checkbox to the checkbox item container.
            checkboxItem.appendChild(label); // Append the label to the checkbox item container.
            checkboxContainer.appendChild(checkboxItem); // Append the checkbox item to the main checkbox container.
            logDebug(`Created checkbox for variable: ${varName}`);
        });

        return true; // Return true to indicate successful creation of checkboxes.
    }

    /**
     * Plots the global variables over time using Plotly, allowing users to select which variables to display.
     * @param {Array} iterations - An array of parsed iteration objects.
     * @param {object} varUnitMap - An object mapping variable names to their units.
     */
    function plotGlobalVariables(iterations, varUnitMap) {
        logDebug('plotGlobalVariables called with iterations:', iterations, 'varUnitMap:', varUnitMap);

        if (typeof Plotly === 'undefined') { // Check if the Plotly library is loaded.
            console.error('Plotly library is not loaded.');
            alert('Plotting functionality is unavailable. Please try again later.');
            return;
        }

        const globalVars = {}; // Initialize an object to store the values of global variables.
        const timeStamps = []; // Initialize an array to store the time stamps for the x-axis.

        iterations.forEach(iter => { // Iterate over each parsed iteration.
            if (iter.performance) { // Check if the iteration contains performance data.
                const gv = iter.performance; // Reference to performance data.
                for (const [key, value] of Object.entries(gv)) { // Iterate over each global variable in the stats.
                    if (!globalVars[key]) { // Initialize the array for the variable if it doesn't exist.
                        globalVars[key] = [];
                    }
                    const numValue = parseFloat(value); // Parse the value as a float if possible.
                    globalVars[key].push(isNaN(numValue) ? value : numValue); // Push the parsed or raw value.
                    logDebug(`Added value for ${key}:`, isNaN(numValue) ? value : numValue);
                }
            }

            // Determine the appropriate time stamp based on available data.
            if (iter.Time) { // If Time is available.
                timeStamps.push(iter.Time);
                logDebug('Added Time stamp:', iter.Time);
            } else if (iter.Iteration) { // Else if Iteration is available.
                timeStamps.push(iter.Iteration);
                logDebug('Added Iteration as Time stamp:', iter.Iteration);
            } else { // Else use the index as Time stamp.
                timeStamps.push(iterations.indexOf(iter) + 1);
                logDebug('Added Index as Time stamp:', iterations.indexOf(iter) + 1);
            }
        });

        const groupedVars = {}; // Initialize an object to group variables by their units.
        for (const key in globalVars) { // Iterate over each global variable.
            const unit = varUnitMap[key] || 'No Units'; // Get the unit from varUnitMap or default to 'No Units'.
            if (!groupedVars[unit]) { // Initialize the group for the unit if it doesn't exist.
                groupedVars[unit] = [];
            }
            groupedVars[unit].push(key); // Add the variable to its respective unit group.
            logDebug(`Grouped variable ${key} under unit ${unit}`);
        }

        const checkboxesCreated = createVariableCheckboxes(globalVars); // Create checkboxes for variable selection.
        if (!checkboxesCreated) { // Check if checkboxes were created successfully.
            console.error("Failed to create variable checkboxes");
            return;
        }

        // Define the layout configuration for the Plotly chart.
        const layout = {
            title: 'Global Variables', // Set the chart title.
            xaxis: {
                title: 'Time',          // Set the x-axis title.
                type: 'linear'          // Set the x-axis type to linear.
            },
            yaxis: {
                title: 'Value',         // Set the y-axis title. Units could be appended here if needed.
                type: 'linear'          // Set the y-axis type to linear.
            },
            showlegend: true,            // Display the legend.
            legend: {
                x: 1,                     // Position the legend on the x-axis.
                xanchor: 'right',         // Anchor the legend to the right.
                y: 1                      // Position the legend on the y-axis.
            }
        };

        /**
         * Updates the Plotly chart based on the selected variables.
         */
        function updatePlot() {
            // Retrieve the names of all selected variables from the checkboxes.
            const selectedVars = Array.from(document.querySelectorAll('#variable-checkboxes input:checked'))
                .map(checkbox => checkbox.name);

            logDebug('Selected variables for plotting:', selectedVars);

            const data = []; // Initialize an array to hold the data traces for Plotly.

            for (const [unit, vars] of Object.entries(groupedVars)) { // Iterate over each unit group.
                vars.forEach(varName => { // Iterate over each variable within the unit group.
                    if (selectedVars.includes(varName)) { // Check if the variable is selected for plotting.
                        const cleanName = varName.replace(/\s*\([^)]*\)/, ''); // Clean the variable name by removing any units if present.
                        data.push({ // Create a data trace for the variable.
                            x: timeStamps, // Set the x-axis data.
                            y: globalVars[varName], // Set the y-axis data.
                            mode: 'lines+markers', // Define the mode as lines and markers.
                            name: varName, // Set the trace name to the variable name.
                            hovertemplate: `${varName}<br>Time: %{x}<br>Value: %{y}<extra></extra>`, // Define the hover template.
                        });
                        logDebug(`Added trace for variable: ${varName}`);
                    }
                });
            }

            const plotlyChart = document.getElementById('plotly-chart'); // Get the Plotly chart container element.
            if (!plotlyChart) { // Check if the Plotly chart element exists.
                console.error("Element with id 'plotly-chart' not found");
                return;
            }

            Plotly.react('plotly-chart', data, layout, {responsive: true}); // Render or update the Plotly chart with the new data and layout.
            logDebug('Plotly chart updated with new data.');
        }

        // Add event listeners to each checkbox to update the plot when selections change.
        document.querySelectorAll('#variable-checkboxes input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', updatePlot);
            logDebug(`Attached change event listener to checkbox: ${checkbox.name}`);
        });

        updatePlot(); // Perform the initial plot rendering.
    }

    /**
     * Handles the click event on the plot button to generate and display the plot.
     */
    function handlePlotButtonClick() {
        // Log a debug message indicating that the plot button was clicked.
        logDebug("Plot button clicked");

        // Retrieve the DOM element that contains the process output content.
        const content = document.getElementById('processOutputContent');

        // Check if the content element exists.
        if (!content) {
            // Log an error if the content element is not found.
            console.error("Element with id 'processOutputContent' not found");
            // Exit the function early since there's no content to process.
            return;
        }

        // Parse all iteration blocks from the text content of the process output.
        const allIterations = parseAllIterations(content.textContent);
        // Extract a mapping of variable names to their units from the text content.
        const varUnitMap = extractVarUnitMap(content.textContent);

        // Log the parsed iterations for debugging purposes.
        logDebug("Parsed iterations:", allIterations);
        // Log the variable-unit mapping for debugging purposes.
        logDebug("Variable unit map:", varUnitMap);

        // Check if there are any iterations to plot.
        if (allIterations.length > 0) {
            // Plot the global variables using the parsed iterations and variable-unit map.
            plotGlobalVariables(allIterations, varUnitMap);
            // Retrieve the DOM element for the plot section.
            const plotSection = document.getElementById('plot-section');
            // Check if the plot section element exists.
            if (plotSection) {
                // Add the 'visible' class to the plot section to make it visible.
                plotSection.classList.add('visible'); /* Add visible class */
                // Trigger a resize of the Plotly chart to ensure it fits the container correctly.
                Plotly.Plots.resize(document.getElementById('plotly-chart')); // **Added Line**
                // Log a debug message indicating that the plot section is now displayed.
                logDebug('Plot section displayed.');
            }
        } else {
            // Log an error if no iterations were found to plot.
            console.error("No iterations found to plot");
            // Alert the user that no data is available to plot.
            alert("No data available to plot. Please make sure the process has generated some output.");
        }
    }

    /**
     * Handles the close event for the Plot section, hiding the plot display.
     */
    function handleClosePlot() {
        logDebug('handleClosePlot called');
        const plotSection = document.getElementById('plot-section');
        if (plotSection) {
            plotSection.classList.remove('visible'); /* Remove visible class */
            logDebug('Plot section hidden.');
        }
    }

    /**
     * Initializes all necessary event listeners for the UI components.
     */
    function initializeEventListeners() {
        logDebug('initializeEventListeners called');

        // ============================
        // File Upload Form Submission
        // ============================

        const uploadForm = document.getElementById('msbUploadForm'); // Select the specific upload form by its ID.
        if (uploadForm) { // Check if the upload form exists.
            uploadForm.addEventListener('submit', uploadFile); // Add a submit event listener to handle file uploads.
            logDebug("Attached submit event listener to upload form.");
        }

        // ============================
        // Close Button for Process Output Popup
        // ============================

        const closeButton = document.getElementById('closeButton'); // Get the close button for the process output popup.
        if (closeButton) { // Check if the close button exists.
            closeButton.addEventListener('click', closeProcessOutput); // Add a click event listener to close the popup.
            logDebug("Attached click event listener to close button.");
        }

        // ============================
        // Update Interval Button
        // ============================

        const updateIntervalButton = document.querySelector('#updateIntervalContainer button'); // Select the update interval button within its container.
        if (updateIntervalButton) { // Check if the button exists.
            updateIntervalButton.addEventListener('click', updateRefreshInterval); // Add a click event listener to update the refresh interval.
            logDebug("Attached click event listener to update interval button.");
        }

        // ============================
        // Scroll Event for Process Output Content
        // ============================

        const outputContent = document.getElementById('processOutputContent'); // Get the process output content element.
        if (outputContent) { // Check if the content element exists.
            outputContent.addEventListener('scroll', handleScroll); // Add a scroll event listener to handle auto-scrolling.
            logDebug("Attached scroll event listener to process output content.");
        }

        // ============================
        // Close Plot Button
        // ============================

        const closePlotButton = document.getElementById('close-plot-button'); // Select the close button for the plot section.
        if (closePlotButton) { // Check if the close plot button exists.
            closePlotButton.addEventListener('click', handleClosePlot); // Add a click event listener to handle closing the plot.
            logDebug("Attached click event listener to close plot button.");
        }

        // ============================
        // Plot Button Click Event
        // ============================

        const plotButton = document.getElementById('plot-button'); // Select the plot button element.
        if (plotButton) { // Check if the plot button exists.
            plotButton.addEventListener('click', handlePlotButtonClick); // Add a click event listener to handle the plot button click.
            logDebug("Attached click event listener to plot button.");
        } else {
            console.error("Plot button not found");
        }

        // ============================
        // Show Upload Form Button
        // ============================

        const showUploadFormButton = document.getElementById('showUploadForm'); // Select the button that triggers the upload form display.
        const uploadPopup = document.getElementById('uploadPopup'); // Select the upload popup element.

        if (showUploadFormButton && uploadPopup) { // Check if both the button and popup exist.
            const uploadPopupContent = uploadPopup.querySelector('.popup-content'); // Select the content area within the upload popup.

            showUploadFormButton.addEventListener('click', function() { // Add a click event listener to the show upload form button.
                logDebug("Show upload form button clicked. Fetching upload form HTML.");

                fetch('/upload') // Fetch the upload form HTML from the server.
                    .then(response => {
                        if (!response.ok) { // Check if the response is successful.
                            throw new Error('Network response was not ok');
                        }
                        return response.text(); // Convert the response to text.
                    })
                    .then(html => {
                        if (uploadPopupContent) { // Check if the upload popup content exists.
                            uploadPopupContent.innerHTML = html; // Insert the fetched HTML into the upload popup content area.
                            uploadPopup.style.display = 'block'; // Display the upload popup.
                            logDebug('Upload popup displayed with fetched HTML.');
                        }

                        const closeUploadForm = document.getElementById('closeUploadForm'); // Select the close button within the upload form.
                        if (closeUploadForm) { // Check if the close upload form button exists.
                            closeUploadForm.addEventListener('click', function() { // Add a click event listener to close the upload popup.
                                uploadPopup.style.display = 'none'; // Hide the upload popup.
                                logDebug('Upload popup hidden via close button.');
                            });
                            logDebug("Attached click event listener to close upload form button.");
                        }

                        const msbUploadForm = document.getElementById('msbUploadForm'); // Select the upload form within the fetched HTML.
                        if (msbUploadForm) { // Check if the upload form exists.
                            msbUploadForm.removeEventListener('submit', uploadFile); // Remove any existing listeners to prevent duplicates.
                            msbUploadForm.addEventListener('submit', uploadFile); // Add a submit event listener to handle the upload process.
                            logDebug("Attached submit event listener to dynamically loaded upload form.");
                        }
                    })
                    .catch(error => { // Handle any errors that occur during the fetch.
                        console.error('Error fetching upload form:', error); // Log the error.
                        alert('Failed to load upload form. Please try again later.'); // Alert the user.
                        logDebug('Failed to fetch upload form HTML.');
                    });
            });

            logDebug("Attached click event listener to show upload form button.");
        } else {
            if (!showUploadFormButton) {
                console.error("Show upload form button with id 'showUploadForm' not found.");
            }
            if (!uploadPopup) {
                console.error("Upload popup element with id 'uploadPopup' not found.");
            }
        }

        // ============================
        // Click Event Listener for Outside Clicks (Process Output Popup)
        // ============================

        window.addEventListener('click', (event) => { // Add a click event listener to the window to handle clicks outside the plot section.
            const plotSection = document.getElementById('plot-section'); // Select the plot section element.
            if (plotSection && event.target === plotSection) { // If the plot section exists and the click target is the plot section itself.
                plotSection.style.display = 'none'; // Hide the plot section.
                logDebug('Plot section hidden via outside click.');
            }
        });
    }

    /**
     * Initializes the application by setting up event listeners.
     */
    function initializeApp() {
        logDebug('initializeApp called');
        initializeEventListeners(); // Initialize all necessary event listeners.
    }

    // ============================
    // DOMContentLoaded Event Listener
    // ============================

    document.addEventListener('DOMContentLoaded', function() { // Add an event listener for when the DOM is fully loaded.
        initializeApp(); // Initialize the application.

        logDebug('DOMContentLoaded event triggered. Application initialized.');
    });

    // ============================
    // Additional Functions (e.g., Plotting)
    // ============================

    // [Include any additional functions here, ensuring they are defined only once and commented thoroughly.]

    // ============================
    // End of Encapsulated Code
    // ============================

})();