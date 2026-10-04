出典: https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
取得日: 2026-09-28
確度: Apple公式OpenAPI仕様の該当schema原文（JSON整形）

```json
{
  "AppAvailabilityV2CreateRequest": {
    "type": "object",
    "title": "AppAvailabilityV2CreateRequest",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "appAvailabilities"
            ]
          },
          "attributes": {
            "type": "object",
            "properties": {
              "availableInNewTerritories": {
                "type": "boolean"
              }
            },
            "required": [
              "availableInNewTerritories"
            ]
          },
          "relationships": {
            "type": "object",
            "properties": {
              "app": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "apps"
                        ]
                      },
                      "id": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "id",
                      "type"
                    ]
                  }
                },
                "required": [
                  "data"
                ]
              },
              "territoryAvailabilities": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "territoryAvailabilities"
                          ]
                        },
                        "id": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "id",
                        "type"
                      ]
                    }
                  }
                },
                "required": [
                  "data"
                ]
              }
            },
            "required": [
              "app",
              "territoryAvailabilities"
            ]
          }
        },
        "required": [
          "relationships",
          "attributes",
          "type"
        ]
      },
      "included": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/TerritoryAvailabilityInlineCreate"
        }
      }
    },
    "required": [
      "data"
    ]
  },
  "TerritoryAvailabilityInlineCreate": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "territoryAvailabilities"
        ]
      },
      "id": {
        "type": "string"
      },
      "attributes": {
        "type": "object",
        "properties": {
          "available": {
            "type": "boolean",
            "nullable": true
          },
          "releaseDate": {
            "type": "string",
            "format": "date",
            "nullable": true
          },
          "preOrderEnabled": {
            "type": "boolean",
            "nullable": true
          }
        }
      },
      "relationships": {
        "type": "object",
        "properties": {
          "territory": {
            "type": "object",
            "properties": {
              "data": {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "territories"
                    ]
                  },
                  "id": {
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "type"
                ]
              }
            }
          }
        }
      }
    },
    "required": [
      "type"
    ]
  }
}
```
