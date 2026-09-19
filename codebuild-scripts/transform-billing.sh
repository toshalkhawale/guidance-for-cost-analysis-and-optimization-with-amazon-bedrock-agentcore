#!/bin/bash
set -euo pipefail

echo "=== Transformation Script: Clone and Transform Billing MCP Server ==="

git clone --depth 1 https://github.com/awslabs/mcp.git
cd mcp/src/billing-cost-management-mcp-server

SERVER_FILE="awslabs/billing_cost_management_mcp_server/server.py"

echo "Transforming server.py..."

python3 << 'PYEOF'
import re, sys

with open("awslabs/billing_cost_management_mcp_server/server.py", "r") as f:
    content = f.read()

# Replace mcp.run() inside main() with streamable-http transport
patched = re.sub(
    r'(def main\(\):.*?)([ \t]+mcp\.run\(\))',
    lambda m: m.group(1) + m.group(2).replace(
        "mcp.run()",
        "mcp.run(transport='streamable-http', host='0.0.0.0', port=8000, stateless_http=True)"
    ),
    content,
    flags=re.DOTALL
)

if patched == content:
    print("ERROR: Could not patch mcp.run() in main()")
    match = re.search(r'def main\(\).*?(?=\ndef |\Z)', content, re.DOTALL)
    if match:
        print("Found main():", match.group(0)[:300])
    sys.exit(1)

with open("awslabs/billing_cost_management_mcp_server/server.py", "w") as f:
    f.write(patched)

print("main() function patched")
print("server.py transformation complete")
PYEOF

grep -q 'streamable-http' "$SERVER_FILE" || { echo "ERROR: streamable-http not found in server.py"; exit 1; }
grep -q 'port=8000' "$SERVER_FILE" || { echo "ERROR: port=8000 not found in server.py"; exit 1; }
echo "server.py transformation verified."

echo "Disabling UV_FROZEN in Dockerfile..."
sed -i 's/UV_FROZEN=1/UV_FROZEN=0/g' Dockerfile
sed -i '/ENV UV_FROZEN/d' Dockerfile

echo "Transforming Dockerfile..."
grep -q 'EXPOSE 8000' Dockerfile || sed -i '/^HEALTHCHECK/i EXPOSE 8000' Dockerfile
sed -i 's|ENTRYPOINT.*|ENTRYPOINT ["python", "-m", "awslabs.billing_cost_management_mcp_server.server"]|' Dockerfile
grep -q 'EXPOSE 8000' Dockerfile || { echo "ERROR: EXPOSE 8000 not in Dockerfile"; exit 1; }
echo "Dockerfile transformation verified."

cat > docker-healthcheck.sh << 'HEALTHCHECK_EOF'
#!/bin/bash
curl -sf http://localhost:8000/mcp || exit 1
HEALTHCHECK_EOF
chmod +x docker-healthcheck.sh

echo "=== All billing MCP server transformations complete ==="
