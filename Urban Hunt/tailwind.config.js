export default {
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
        display: ["Rajdhani", "Arial Narrow", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
