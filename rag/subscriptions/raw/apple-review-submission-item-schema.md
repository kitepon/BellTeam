出典: https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
取得日: 2026-10-02
確度: Apple公式OpenAPI 4.5 の原文抜粋

ReviewSubmissionItemCreateRequest:

```json
{
  "type": "object",
  "title": "ReviewSubmissionItemCreateRequest",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "reviewSubmissionItems"
          ]
        },
        "relationships": {
          "type": "object",
          "properties": {
            "reviewSubmission": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "reviewSubmissions"
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
            "appStoreVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "appStoreVersions"
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
            "appCustomProductPageVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "appCustomProductPageVersions"
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
            "appStoreVersionExperiment": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "appStoreVersionExperiments"
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
            "appStoreVersionExperimentV2": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "appStoreVersionExperiments"
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
            "appEvent": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "appEvents"
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
            "backgroundAssetVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "backgroundAssetVersions"
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
            "gameCenterAchievementVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "gameCenterAchievementVersions"
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
            "gameCenterActivityVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "gameCenterActivityVersions"
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
            "gameCenterChallengeVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "gameCenterChallengeVersions"
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
            "gameCenterLeaderboardSetVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "gameCenterLeaderboardSetVersions"
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
            "gameCenterLeaderboardVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "gameCenterLeaderboardVersions"
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
            "inAppPurchaseVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "inAppPurchaseVersions"
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
            "subscriptionVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "subscriptionVersions"
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
            "subscriptionGroupVersion": {
              "type": "object",
              "properties": {
                "data": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "subscriptionGroupVersions"
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
          "required": [
            "reviewSubmission"
          ]
        }
      },
      "required": [
        "relationships",
        "type"
      ]
    }
  },
  "required": [
    "data"
  ]
}
```
