plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.dgghita.wizzroutefinder"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dgghita.wizzroutefinder"
        minSdk = 24
        targetSdk = 34
        versionCode = 20
        versionName = "2.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Personal sideload: sign release with the debug key so it
            // installs over the debug builds (same applicationId + key)
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    sourceSets {
        getByName("main") {
            // Reuse the same HTML/JS/CSS as the Chrome extension (repo-root shared/)
            assets.srcDirs(files("$projectDir/../../shared"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    applicationVariants.all {
        outputs.all {
            val output = this as com.android.build.gradle.internal.api.BaseVariantOutputImpl
            output.outputFileName =
                "WizzRouteFinder-v${versionName}-build${versionCode}-${name}.apk"
        }
    }
}

dependencies {
    // Pure WebView app - no AndroidX dependencies needed
}
