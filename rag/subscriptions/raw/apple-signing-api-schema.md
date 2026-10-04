出典: https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
取得日: 2026-09-28
確度: Apple公式OpenAPI仕様の該当schema原文（JSON整形）

```json
{
  "CertificateCreateRequest": {
    "type": "object",
    "title": "CertificateCreateRequest",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "certificates"
            ]
          },
          "attributes": {
            "type": "object",
            "properties": {
              "csrContent": {
                "type": "string"
              },
              "certificateType": {
                "$ref": "#/components/schemas/CertificateType"
              }
            },
            "required": [
              "csrContent",
              "certificateType"
            ]
          },
          "relationships": {
            "type": "object",
            "properties": {
              "merchantId": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "merchantIds"
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
              "passTypeId": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "passTypeIds"
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
          "attributes",
          "type"
        ]
      }
    },
    "required": [
      "data"
    ]
  },
  "CertificateType": {
    "type": "string",
    "enum": [
      "APPLE_PAY",
      "APPLE_PAY_MERCHANT_IDENTITY",
      "APPLE_PAY_PSP_IDENTITY",
      "APPLE_PAY_RSA",
      "DEVELOPER_ID_KEXT",
      "DEVELOPER_ID_KEXT_G2",
      "DEVELOPER_ID_APPLICATION",
      "DEVELOPER_ID_APPLICATION_G2",
      "DEVELOPMENT",
      "DISTRIBUTION",
      "IDENTITY_ACCESS",
      "IOS_DEVELOPMENT",
      "IOS_DISTRIBUTION",
      "MAC_APP_DISTRIBUTION",
      "MAC_INSTALLER_DISTRIBUTION",
      "MAC_APP_DEVELOPMENT",
      "PASS_TYPE_ID",
      "PASS_TYPE_ID_WITH_NFC"
    ]
  },
  "ProfileCreateRequest": {
    "type": "object",
    "title": "ProfileCreateRequest",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "profiles"
            ]
          },
          "attributes": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "profileType": {
                "type": "string",
                "enum": [
                  "IOS_APP_DEVELOPMENT",
                  "IOS_APP_STORE",
                  "IOS_APP_ADHOC",
                  "IOS_APP_INHOUSE",
                  "MAC_APP_DEVELOPMENT",
                  "MAC_APP_STORE",
                  "MAC_APP_DIRECT",
                  "TVOS_APP_DEVELOPMENT",
                  "TVOS_APP_STORE",
                  "TVOS_APP_ADHOC",
                  "TVOS_APP_INHOUSE",
                  "MAC_CATALYST_APP_DEVELOPMENT",
                  "MAC_CATALYST_APP_STORE",
                  "MAC_CATALYST_APP_DIRECT"
                ]
              }
            },
            "required": [
              "profileType",
              "name"
            ]
          },
          "relationships": {
            "type": "object",
            "properties": {
              "bundleId": {
                "type": "object",
                "properties": {
                  "data": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "bundleIds"
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
              "devices": {
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
                            "devices"
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
              },
              "certificates": {
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
                            "certificates"
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
              "certificates",
              "bundleId"
            ]
          }
        },
        "required": [
          "relationships",
          "attributes",
          "type"
        ]
      }
    },
    "required": [
      "data"
    ]
  }
}
```
