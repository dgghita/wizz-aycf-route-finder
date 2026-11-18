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
        versionCode = 2
        versionName = "1.9.9"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
}

dependencies {
    // Pure WebView app - no AndroidX dependencies needed
}
