function Load-Env {
    param (
        [string]$Path = ".env"
    )

    if (-not (Test-Path $Path)) {
        Write-Warning "Could not find $Path"
        return
    }

    Get-Content $Path | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' } | ForEach-Object {
        # Split into name and value, limiting to 2 parts, and trim whitespace
        $name, $value = $_.Split('=', 2).Trim()
        
        # Remove leading and trailing single or double quotes
        $value = $value -replace '^["'']|["'']$', ''
        
        # Set the environment variable for the current process
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
    
    Write-Host "Environment variables loaded from $Path" -ForegroundColor Green
}

# To execute it:
Load-Env