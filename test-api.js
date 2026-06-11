async function executeCustomFetch() {
  const url = "https://agentrouter.org/v1/chat/completions"; // Update path if needed
  
  // Your payload data
  const payload = {
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "Who are you" }]
    // ... add the rest of your data to match the expected size
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-BJJ8Jsq8j2d4dB0B39Mx1G9z9Wtz3dA3cEFz5tBRJkWZv2tX",
        "Content-Type": "application/json",
        "User-Agent": "Kilo-Code/7.3.41 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
        "http-referer": "https://kilocode.ai",
        "x-title": "Kilo Code",
        "Accept": "*/*",
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("Success:", JSON.stringify(data));

  } catch (error) {
    console.error("Fetch request failed:", error);
  }
}

executeCustomFetch();

// Content-Type: application/json
// User-Agent: Kilo-Code/7.3.41 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
// http-referer: https://kilocode.ai
// x-title: Kilo Code
// Accept: */*

