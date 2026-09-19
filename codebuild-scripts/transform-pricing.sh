#!/bin/bash
set -euo pipefail

echo "=== Transformation Script: Clone and Transform Pricing MCP Server ==="

git clone --depth 1 https://github.com/awslabs/mcp.git
cd mcp/src/aws-pricing-mcp-server

SERVER_FILE="awslabs/aws_pricing_mcp_server/server.py"

echo "Transforming server.py..."

python3 << 'PYEOF'
import re, sys

with open("awslabs/aws_pricing_mcp_server/server.py", "r") as f:
    content = f.read()

# 1. Patch mcp.run() inside main() with streamable-http transport
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
content = patched
print("main() function patched")

# 2. Fix get_pricing type annotations to avoid $ref in schema (if present)
content = re.sub(r'filters:\s*Optional\[List\[PricingFilter\]\]', 'filters: Optional[List[dict]]', content)
content = re.sub(r'output_options:\s*Optional\[OutputOptions\]', 'output_options: Optional[dict]', content)
print("Patched get_pricing type annotations")

# 3. Fix model_dump() calls for dict compatibility (if present)
content = content.replace(
    'api_filters.extend([f.model_dump(by_alias=True) for f in filters])',
    'api_filters.extend([f if isinstance(f, dict) else f.model_dump(by_alias=True) for f in filters])'
)
print("Patched model_dump calls")

with open("awslabs/aws_pricing_mcp_server/server.py", "w") as f:
    f.write(content)

print("server.py transformation complete")
PYEOF

grep -q 'streamable-http' "$SERVER_FILE" || { echo "ERROR: streamable-http not found in server.py"; exit 1; }
grep -q 'port=8000' "$SERVER_FILE" || { echo "ERROR: port=8000 not found in server.py"; exit 1; }
echo "server.py transformation verified."

echo "Disabling UV_FROZEN and --frozen in Dockerfile..."
sed -i 's/UV_FROZEN=1/UV_FROZEN=0/g' Dockerfile
sed -i '/ENV UV_FROZEN/d' Dockerfile
sed -i 's/ --frozen//g' Dockerfile

echo "Transforming Dockerfile..."
grep -q 'EXPOSE 8000' Dockerfile || sed -i '/^HEALTHCHECK/i EXPOSE 8000' Dockerfile
sed -i 's|ENTRYPOINT.*|ENTRYPOINT ["python", "-m", "awslabs.aws_pricing_mcp_server.server"]|' Dockerfile
grep -q 'EXPOSE 8000' Dockerfile || { echo "ERROR: EXPOSE 8000 not in Dockerfile"; exit 1; }
echo "Dockerfile transformation verified."

cat > docker-healthcheck.sh << 'HEALTHCHECK_EOF'
#!/bin/bash
curl -sf http://localhost:8000/mcp || exit 1
HEALTHCHECK_EOF
chmod +x docker-healthcheck.sh

echo "=== All pricing MCP server transformations complete ==="
